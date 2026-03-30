---
description: Test parse functionality
agent: analyze
literate: true
---

```yaml {config}
step: ask-topic
parse:
    topic: "What topic should we use?"
    count: "How many items (a number)?"
```
Please provide a topic name and a count number.

---

Step 2: The topic is "$topic" and count is $count.
