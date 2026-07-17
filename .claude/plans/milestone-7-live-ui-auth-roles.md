# Milestone M7 — Live UI, Auth, Roles (Stage 1 + 2)

**Status**: COMPLETED
**Version**: v2.7.0
**Completed**: 2026-04-06
**Branch**: main (merged directly)

---

## Objective

Ship a publicly accessible frontend with real auth and role-based access — no more mock data, no demo mode.

---

## Acceptance Criteria

- [x] Frontend deployed to a public URL
- [x] Login page hits real `POST /api/auth/login` endpoint (JWT)
- [x] Session persists across refresh via `GET /api/auth/me`
- [x] `UserRole` type: `viewer | admin | super_admin`
- [x] `hasRole()` helper and `RequireRole` component for route gating
- [x] Dashboard shows live stats + courses via `useQuery` (no MOCK_DATA)
- [x] Sidebar nav filtered by user role; role badge shown; sign-out works
- [x] `/api/users` CRUD endpoint with role guards
- [x] Users page wired to real API, gated to admin+
- [x] `requireRole()` middleware added to backend auth.ts
- [x] All 3 packages build cleanly (`database`, `backend`, `frontend`)
- [x] Deployed: frontend at `https://ekatra-frontend-production.up.railway.app`

---

## Files Changed

### Frontend
- `apps/frontend/src/components/AuthProvider.tsx` — rewritten: real JWT auth, session restore, RequireRole
- `apps/frontend/src/pages/Dashboard.tsx` — rewritten: live stats + courses via useQuery, Skeleton loaders
- `apps/frontend/src/pages/Courses.tsx` — removed MOCK_COURSES initialData
- `apps/frontend/src/pages/Users.tsx` — rewritten: /api/users, RequireRole gate, UUID→numeric ID mapper
- `apps/frontend/src/components/dashboard/Sidebar.tsx` — role-filtered nav, badge, real signOut
- `apps/frontend/src/lib/constants.ts` — DASHBOARD_SECTIONS minRole added
- `apps/frontend/Dockerfile` — new: multi-stage node+nginx build
- `apps/frontend/nginx.conf` — new: SPA routing, gzip, security headers
- `.dockerignore` — removed `apps/frontend` exclusion

### Backend
- `apps/backend/src/middleware/auth.ts` — added `requireRole()` helper
- `apps/backend/src/routes/users.ts` — new: GET/POST/PUT/DELETE /api/users
- `apps/backend/src/index.ts` — registered usersRouter at /api/users

### Database Package
- `packages/database/src/index.ts` — usersRepo: added findAll, update, delete

---

## Architecture Notes

- Auth token stored in `localStorage('auth_token')` — cleared on signOut
- Role hierarchy: `viewer (0) < admin (1) < super_admin (2)` — super_admin always passes all role checks
- Backend: `requireRole(...roles)` allows super_admin bypass automatically
- Frontend: `RequireRole` renders fallback Alert instead of throwing; `meetsRole()` in Sidebar uses ROLE_ORDER index comparison
- `/api/users` is org-scoped — users only see others in their own organization via `organizationId` from JWT claims
- VITE_API_URL build arg baked into nginx static bundle at build time

---

## Known Limitations

- No `super_admin` creation path yet — only `admin` seed exists
- JWT stored in localStorage (XSS risk if site is compromised — acceptable for current pilot scale)
- Frontend bundle is 1071KB (chunk warning) — not optimized, acceptable for internal tool
