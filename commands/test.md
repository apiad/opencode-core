---
description: Test script execution in step 0
agent: analyze
literate: true
---

Script test in step 0:

```bash {exec}
echo "hello from bash"
```
```python {exec mode=store}
import json
print(json.dumps({"topic": "testing", "count": 42}))
```

The script returned: topic="$topic", count=$count

---

Step 2: This is the second step.

---

Step 3: This is the third and final step.
