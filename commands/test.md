---
description: Test literate commands plugin
agent: analyze
literate: true
---

Step 1: This is the first step. Args: $ARGUMENTS

---

```yaml {config}
step: script-test
```
Testing script execution:

```bash {exec}
echo "hello from bash"
```
```python {exec mode=store}
import json
print(json.dumps({"topic": "testing", "count": 42}))
```

The script returned: topic="$topic", count=$count

---

Step 3: This is the third and final step.
