---
name: auth-role-from-user-input
description: Role / permission / isAdmin value taken from request body or query
triggers:
  files:
    - "*.ts"
    - "*.tsx"
    - "*.js"
    - "*.jsx"
    - "*.mjs"
    - "*.cjs"
    - "*.py"
    - "*.go"
    - "*.rb"
    - "**/*.ts"
    - "**/*.tsx"
    - "**/*.js"
    - "**/*.jsx"
    - "**/*.mjs"
    - "**/*.cjs"
    - "**/*.py"
    - "**/*.go"
    - "**/*.rb"
  hunk_regex: "(role|permission|isAdmin|is_admin|tier|plan|scopes?)\\b"
security: true
confidence_floor: 0.75
---

A role / permission / `isAdmin` / tier / plan value is being read
from request input (`req.body`, `req.query`, form data, JSON
payload) and used for an authorization check OR written to a
persistent record. This is the classic privilege-escalation bug:
the attacker passes `{"role": "admin"}` in the POST and the system
trusts it.

Flag when:
- a string/bool from request input is assigned to a `role` /
  `permission` / `isAdmin` column on an `INSERT` / `UPDATE`
- a check like `if (req.body.role === 'admin')` gates an action
- a JWT / session is created with a `role` claim copied from input

Suppress when:
- the role assignment is explicitly gated by an admin-only
  authorization check earlier in the function (look for
  `requireRole('admin')` / `ctx.user.isAdmin`)
- the input goes through an allow-list AND the user is already an
  admin (e.g. an admin promoting another user)
- the value is being compared to derive a STRING used for routing /
  filtering (not for an authorization decision)
