import type { Env } from "./env.js";
import { route } from "./router.js";
import { runClock } from "./clock.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },

  /** The decision-deadline clock: once a day (wrangler `triggers.crons`). */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runClock(env, new Date(controller.scheduledTime)).then((r) => {
        // eslint-disable-next-line no-console -- one structured line per nightly run
        console.log(JSON.stringify({ level: "info", msg: "arc clock run", ...r }));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
