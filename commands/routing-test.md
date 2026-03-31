---
description: Test routing with next config
agent: analyze
literate: true
---

```yaml {config}
step: ask-role
parse:
    role: string
next:
    role === 'admin': admin-panel
    role === 'user': user-panel
    _: guest-panel
```

What is your role? Please respond with admin, user, or guest.

User instructions: $ARGUMENTS

---
```yaml {config}
step: admin-panel
stop: true
```

# Admin Panel
Welcome, Administrator! You have full access.

---
```yaml {config}
step: user-panel
stop: true
```

# User Panel
Welcome, User! You have standard access.

---
```yaml {config}
step: guest-panel
stop: true
```

# Guest Panel
Welcome, Guest! Please sign up for an account.
