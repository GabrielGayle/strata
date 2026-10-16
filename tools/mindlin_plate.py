#!/usr/bin/env python3
"""2D Reissner–Mindlin eigenproblem for one free-free steel plate.

300 mm × 50 mm × 3 mm, the same strip the 1D Timoshenko bar is checked
against. Bending is integrated with the default quadrature; shear uses one
point per quad so a thin plate does not lock. No boundary conditions: the
three rigid-body modes fall out of the spectrum and the next is f1.

Run from the repo root:

    python3 tools/mindlin_plate.py

The same script under Pyodide is `node tools/mindlin_pyodide.mjs`
(see docs/tuning.md). Prints analytic f = 1.028·c·t/L², the 2D partials,
and the solve time.
"""

from __future__ import annotations

import json
import time

import numpy as np
from skfem import Basis, BilinearForm, ElementQuad1, ElementVector, MeshQuad, asm
from scipy.sparse.linalg import eigsh

# Steel, matching src/core/tuning.ts MATERIALS.steel
E = 200e9
RHO = 7850.0
NU = 0.30
KAPPA = 5.0 / 6.0
L = 0.300  # m, along the bar
W = 0.050
T = 0.003
C = float(np.sqrt(E / RHO))
ANALYTIC = 1.028 * C * T / L**2

# ~10 mm quads: 30 × 5. Enough for f1, still a small eigenproblem.
NX, NY = 30, 5


def assemble(nx=NX, ny=NY):
    mesh = MeshQuad.init_tensor(np.linspace(0.0, L, nx + 1), np.linspace(0.0, W, ny + 1))
    element = ElementVector(ElementQuad1(), 3)
    basis = Basis(mesh, element)
    # one-point rule on the unit square, for shear only
    shear_basis = Basis(mesh, element, quadrature=(np.array([[0.5], [0.5]]), np.array([1.0])))

    G = E / (2.0 * (1.0 + NU))
    Db = E * T**3 / (12.0 * (1.0 - NU**2))
    Gs = KAPPA * G * T
    rotary = RHO * T**3 / 12.0

    @BilinearForm
    def bending(u, v, w):
        # u[0] = transverse w, u[1] = θx, u[2] = θy
        kx_u, ky_u = u.grad[1, 0], u.grad[2, 1]
        kx_v, ky_v = v.grad[1, 0], v.grad[2, 1]
        kxy_u = u.grad[1, 1] + u.grad[2, 0]
        kxy_v = v.grad[1, 1] + v.grad[2, 0]
        return Db * (
            kx_u * kx_v
            + ky_u * ky_v
            + NU * (kx_u * ky_v + ky_u * kx_v)
            + 0.5 * (1.0 - NU) * kxy_u * kxy_v
        )

    @BilinearForm
    def shear(u, v, w):
        gx_u = u.grad[0, 0] - u.value[1]
        gy_u = u.grad[0, 1] - u.value[2]
        gx_v = v.grad[0, 0] - v.value[1]
        gy_v = v.grad[0, 1] - v.value[2]
        return Gs * (gx_u * gx_v + gy_u * gy_v)

    @BilinearForm
    def mass(u, v, w):
        return RHO * T * u.value[0] * v.value[0] + rotary * (u.value[1] * v.value[1] + u.value[2] * v.value[2])

    K = (asm(bending, basis) + asm(shear, shear_basis)).tocsr()
    M = asm(mass, basis).tocsr()
    return K, M, basis.N, basis


def _nearest_node(xy, target):
    d = (xy[0] - target[0]) ** 2 + (xy[1] - target[1]) ** 2
    return int(np.argmin(d))


def spectrum(K, M, basis, n_modes=12):
    # eigenvalues nearest a small positive shift: rigid-body modes, then bending
    # fixed start vector so the reported hertz do not wander with ARPACK's random v0
    vals, vecs = eigsh(K, k=n_modes, M=M, sigma=1.0, which="LM", tol=1e-12, v0=np.ones(K.shape[0]))
    order = np.argsort(np.real(vals))
    # nodal_dofs row 0 is transverse w. ElementVector.probes unpacks a scalar basis.
    xy = basis.mesh.p
    wdof = basis.nodal_dofs[0]
    # Classify on an end cross-section. The first torsion mode has a node at
    # mid-length, so a mid-span sample is ~0 and cannot tell bend from twist.
    left = _nearest_node(xy, (0.0, 0.20 * W))
    right = _nearest_node(xy, (0.0, 0.80 * W))
    out = []
    for col in order:
        lam = float(np.real(vals[col]))
        if lam <= 1.0:
            continue
        wl = float(vecs[wdof[left], col])
        wr = float(vecs[wdof[right], col])
        kind = "twist" if abs(wl + wr) < abs(wl - wr) else "bend"
        out.append({"hz": float(np.sqrt(lam) / (2.0 * np.pi)), "kind": kind})
    return out


def main():
    t0 = time.perf_counter()
    K, M, ndof, basis = assemble()
    t_asm = time.perf_counter() - t0
    t1 = time.perf_counter()
    modes = spectrum(K, M, basis)
    t_eig = time.perf_counter() - t1
    bends = [m["hz"] for m in modes if m["kind"] == "bend"]
    report = {
        "plate_mm": [L * 1000, W * 1000, T * 1000],
        "c_m_s": C,
        "analytic_hz": ANALYTIC,
        "ndof": int(ndof),
        "mesh": [NX, NY],
        "modes": modes[:6],
        "bending_hz": bends[:3],
        "assemble_s": t_asm,
        "eig_s": t_eig,
        "solve_s": t_asm + t_eig,
        "f1_over_analytic": (bends[0] / ANALYTIC) if bends else None,
    }
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
