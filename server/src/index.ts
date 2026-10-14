import 'dotenv/config';
import { createApp } from './app.js';
import { migrate } from './db/migrate.js';
import { runScheduledJobs } from './services/jobs.js';
import { checkProductionEnv } from './env.js';

checkProductionEnv();
const port = Number(process.env.PORT ?? 4000);

await migrate();
createApp().listen(port, () => console.log(`Y11 HQ API running on http://localhost:${port}`));

// Every 10 minutes: auto-end long shifts, overdue in-hand alerts, the 2-month level check.
// Each job only changes something when a deadline has actually passed.
const jobs = () => runScheduledJobs().catch((e) => console.error('Scheduled jobs failed', e));
jobs();
setInterval(jobs, 10 * 60 * 1000);

// Recruiter demo copy: put the fake data back every 24 hours, so visitors can click anything.
if (process.env.DEMO_MODE === 'true') {
  const { seedAll } = await import('./db/seed.js');
  setInterval(() => seedAll({ reset: true }).catch((e) => console.error('Demo reset failed', e)), 24 * 3600 * 1000);
}
