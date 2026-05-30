# ClaimFlow — SHA Claims Documentation Audit Platform

## Project Overview
ClaimFlow is a deterministic claims documentation audit platform deployed inside Kenyan hospitals to verify SHA (Social Health Authority) claims documentation before submission to AfyaLink HIE.

## Specification Documents
- `/docs/ClaimFlow_Complete_Specification_Package.md` — Full specification (Sections 1-37)

## Technology Stack
- Backend API + Rule Engine: TypeScript + Fastify (Node.js 20 LTS)
- Frontend: Next.js 14 (TypeScript)
- ML Service: Python 3.11 + FastAPI
- Database: PostgreSQL 17
- Job Queue: pg-boss (Postgres-native)
- Storage: Local filesystem behind DocumentStore interface
- Auth: In-app JWT RS256 + TOTP MFA
- Package Manager: pnpm workspaces
- Testing: Vitest (TS), pytest (Python), Playwright (e2e)

## Architecture
Modular monolith deployed as Docker containers. Single shared database. API ↔ ML service is the only network boundary.

## Pilot Hospital
Mary Help of the Sick Mission Hospital, Thika, Kiambu County
- SHA Facility Registry: FID-22-106718-4
- Registration Number: 000210
- Level: LEVEL_4

## Code Conventions
- Strict TypeScript (no `any`)
- All database queries must include tenant_id
- All API responses use envelope: { data, meta?, errors? }
- All dates in ISO 8601
- All money in NUMERIC(12,2), stored as KES
- UUIDs for all primary keys
- Zod for request validation
- Structured JSON logging (no console.log in production)
