# API Reference — FSM Definitions

**Base path**: `/api/fsm`
**Auth**: All endpoints require a valid JWT (`Authorization: Bearer <token>`)
**Minimum role**: `admin` (read + write), `super_admin` (delete)

---

## Endpoints

### GET /api/fsm
List all FSM definitions for the authenticated user's organization.

**Auth**: admin+

**Response 200**
```json
{
  "success": true,
  "data": [
    {
      "id": "uuid",
      "name": "Literacy Course Flow",
      "version": 3,
      "created_at": "2026-04-07T10:00:00Z",
      "updated_at": "2026-04-07T11:30:00Z"
    }
  ]
}
```
> Note: `fsm_json` is NOT included in list responses (projection narrowing planned).

---

### GET /api/fsm/:id
Get a single FSM definition including full `fsm_json`.

**Auth**: admin+

**Response 200**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "organization_id": "uuid",
    "name": "Literacy Course Flow",
    "version": 3,
    "fsm_json": {
      "nodes": [
        { "id": "start", "type": "start", "data": { "label": "Start" }, "position": { "x": 100, "y": 100 } }
      ],
      "edges": []
    },
    "created_by": "user-uuid",
    "created_at": "2026-04-07T10:00:00Z",
    "updated_at": "2026-04-07T11:30:00Z"
  }
}
```

**Response 404**: Definition not found or not in org.

---

### POST /api/fsm
Create a new FSM definition.

**Auth**: admin+

**Request body**
```json
{
  "name": "Literacy Course Flow",
  "fsmJson": {
    "nodes": [],
    "edges": []
  }
}
```

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `name` | string | yes | 1–255 chars |
| `fsmJson` | object | no | Max 64KB serialized; default `{"states":[],"transitions":[]}` |

**Response 201**
```json
{
  "success": true,
  "data": { "id": "uuid", "organization_id": "uuid", "name": "...", "version": 1, "fsm_json": {} }
}
```

**Response 400**: `name is required` / `name too long` / `fsmJson too large`

---

### PUT /api/fsm/:id
Update name and/or `fsm_json`. Increments `version` by 1. Last-write-wins (no conflict detection).

**Auth**: admin+

**Request body** (all fields optional)
```json
{
  "name": "Updated Name",
  "fsmJson": { "nodes": [...], "edges": [...] }
}
```

| Field | Constraints |
|-------|-------------|
| `name` | 1–255 chars if provided |
| `fsmJson` | Max 64KB serialized if provided |

**Response 200**
```json
{
  "success": true,
  "data": { "id": "uuid", "name": "...", "version": 4, "fsm_json": {}, "updated_at": "..." }
}
```

**Response 404**: Not found or not in org.

---

### DELETE /api/fsm/:id
Delete an FSM definition. Courses with `fsm_definition_id` pointing to this will be set to `NULL` (ON DELETE SET NULL).

**Auth**: super_admin only

**Response 204**: No content.

**Response 404**: Not found or not in org.

---

## Data Types

```typescript
interface FSMNode {
  id: string;
  type: 'start' | 'lesson' | 'question' | 'end';
  data: { label: string; [key: string]: unknown };
  position: { x: number; y: number };
  style?: Record<string, unknown>;
}

interface FSMEdge {
  id: string;
  source: string;  // node id
  target: string;  // node id
  label?: string;
}

interface FSMJson {
  nodes: FSMNode[];
  edges: FSMEdge[];
}
```

> **Schema note**: `fsm_json` currently stores the full React Flow canvas state including positional data. A future migration will split into `logic_json` (semantic FSM) and `layout_json` (render positions).

---

## Authentication Errors

| Code | Meaning |
|------|---------|
| 401 | Missing or invalid JWT |
| 403 | Insufficient role (e.g., viewer calling admin+ endpoint) |
| 404 | Resource not found **or** not in caller's organization (no information leakage) |
