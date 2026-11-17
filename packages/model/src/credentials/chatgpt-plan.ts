/**
 * THE APP NAME OF SIGN IN WITH CHATGPT (credential management §11).
 *
 * Sent as `agent_name_hint` when Podium registers on a person's first
 * ChatGPT sign-in, and as `initialize.clientInfo.name` by every Codex
 * app-server session, which is how OpenAI attributes a plan's use to the app
 * the person connected (POD-6894 report §9, Task 15 item 2). One constant, so
 * the two can never differ.
 */
export const CHATGPT_APP_NAME = 'Podium'
