# Hello Jibo

This is a data-only touchscreen skill. On Node.js 20 or later, run:

```
node --test test.mjs
node index.js
```

The preview prints screen and speech events; it does not contact or control a robot.
Use the Phoenix skill kit to validate and pack. Replace skill.json's example appId
with the identity you create in /apps#publisher before submitting.

index.js and test.mjs run on your computer only. They are retained for review but
never executed by the Skill Store or included in the robot's data-only artifact.
There are no jibo.* JavaScript APIs, arbitrary network calls or persistent storage
in the declarative runtime. Native local-test support is a different contract.
