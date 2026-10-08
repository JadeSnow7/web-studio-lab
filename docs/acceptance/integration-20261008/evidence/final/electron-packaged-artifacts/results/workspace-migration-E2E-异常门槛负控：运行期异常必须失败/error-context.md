# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: workspace-migration.spec.ts >> E2E 异常门槛负控：运行期异常必须失败
- Location: e2e/workspace-migration.spec.ts:253:1

# Error details

```
Error: electronApplication.evaluate: TypeError: Cannot read properties of undefined (reading 'length')
    at eval (eval at evaluate (:311:30), <anonymous>:1:38)
    at UtilityScript.evaluate (<anonymous>:313:16)
    at UtilityScript.<anonymous> (<anonymous>:1:44)
```