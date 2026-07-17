# Ekatra Platform - Development Principles

## Core Philosophy: Smart Work, Not Hard Work

### 1. **Leverage Existing Code**
- ✅ **DO**: Copy and adapt working code from existing projects
- ✅ **DO**: Reference patterns from TBS-Mindset-v2, socrates-ek, microlearn-main
- ❌ **DON'T**: Rewrite functionality that already exists
- ❌ **DON'T**: Reinvent the wheel

**Example**: 
```typescript
// ✅ GOOD: Use existing CourseDeliveryService pattern from TBS-Mindset
// ❌ BAD: Write new course delivery logic from scratch
```

### 2. **Code Efficiency**
- **Clean**: Self-documenting variable names, clear function purposes
- **Commented**: Brief comments for complex logic, not obvious statements
- **Not Verbose**: DRY principle, reusable functions, no unnecessary abstractions
- **Efficient**: O(n) over O(n²), database queries over loops, caching where beneficial

**Example**:
```typescript
// ❌ VERBOSE
async function getUserById(userId: string) {
  // Get the user from the database
  const user = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
  // Return the user
  return user;
}

// ✅ CLEAN & EFFICIENT
async function getUser(id: string) {
  return db.users.findById(id); // Repository pattern, single query
}
```

### 3. **Reusable Assets**

#### From microlearn-main:
- `/src/services/whatsappService.ts` - WhatsApp Cloud API implementation
- `/supabase/migrations/*.sql` - Complete 413-line database schema
- `/src/components/CourseEditor.tsx` - Course editing UI
- `/src/components/UsersList.tsx` - Learner management UI

#### From TBS-Mindset-v2:
- `server.js` - Cron scheduling patterns (lines 1-150)
- `test.js` - Module delivery logic (lines 100-800)
- Webhook handling patterns

#### From socrates-ek:
- `Nodejs_backend/server.js` - AI course generation
- Q&A interaction patterns

### 4. **File Structure Conventions**

```
ekatra-platform/
├── apps/
│   ├── backend/         # Node.js/Express API
│   ├── frontend/        # React admin dashboard (copy microlearn-main)
│   └── worker/          # Background jobs (BullMQ)
├── packages/
│   ├── database/        # PostgreSQL client + schema
│   ├── messaging/       # WhatsApp abstraction layer
│   └── shared/          # Common types/utils
├── infrastructure/
│   ├── docker/          # Docker Compose configs
│   └── azure/           # Azure deployment (Bicep)
└── docs/                # API docs, architecture
```

### 5. **Development Workflow**

1. **Check existing code first**: `grep -r "function_name" . --include="*.ts"`
2. **Copy, don't recreate**: Adapt existing patterns to new needs
3. **Test incrementally**: Small commits, test each change
4. **Document decisions**: Update CLAUDE.md with architectural choices

### 6. **Code Review Checklist**

Before committing:
- [ ] Is this functionality already implemented elsewhere?
- [ ] Can I reuse an existing function/pattern?
- [ ] Are comments necessary or is the code self-documenting?
- [ ] Is this the most efficient algorithm/approach?
- [ ] Does this follow the existing project structure?

### 7. **Performance Guidelines**

- **Database**: Use repository pattern, avoid N+1 queries
- **API**: Paginate large datasets, add indexes to DB
- **Caching**: Redis for frequently accessed data (TTL: 5-60min)
- **WhatsApp**: Queue messages, rate limit to avoid blocks

### 8. **Security Best Practices**

- Validate webhook signatures (Meta App Secret)
- Sanitize all user inputs
- Use environment variables for secrets
- Rate limit API endpoints
- Log security events

### 9. **Cost Optimization**

- Use LLM routing (Llama 3.2 for bulk, GPT-4o for complex)
- Cache OpenAI embeddings
- Optimize image sizes before sending
- Use consumption-based Azure Functions where possible

### 10. **Quick Reference: What to Reuse**

| Need | Reuse From | File |
|------|-----------|------|
| WhatsApp sending | microlearn-main | `src/services/whatsappService.ts` |
| Database schema | microlearn-main | `supabase/migrations/*.sql` |
| Cron scheduling | TBS-Mindset-v2 | `server.js` (lines 1-150) |
| Module delivery | TBS-Mindset-v2 | `test.js` (lines 100-800) |
| AI course generation | socrates-ek | `Nodejs_backend/server.js` |
| Q&A patterns | socratic-learning-bot | `lib/socraticMethod.js` |
| Admin UI components | microlearn-main | `src/components/*` |

---

**Remember**: The goal is rapid, efficient development. If it works elsewhere, use it. If it's complex, comment it. If it's repetitive, abstract it.
