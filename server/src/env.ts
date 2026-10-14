/**
 * Online (NODE_ENV=production), refuse to start with missing or example secrets rather than run unsafely.
 * Runs before the seed, because the CEO login is created from OWNER_PASSWORD only on the very first start.
 */
export function checkProductionEnv(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV !== 'production') return;
  const problems: string[] = [];
  if (!env.DATABASE_URL) problems.push('DATABASE_URL is not set');
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32 || env.JWT_SECRET.startsWith('change-me')) {
    problems.push('JWT_SECRET must be a long random value (at least 32 characters)');
  }
  if (!env.OWNER_PASSWORD || env.OWNER_PASSWORD.length < 10 || env.OWNER_PASSWORD.startsWith('change-me')) {
    problems.push('OWNER_PASSWORD must be at least 10 characters and not the example value');
  }
  // Optional (the website connection), but if it's set it must be hard to guess.
  if (env.WEBSITE_API_KEY !== undefined && env.WEBSITE_API_KEY.length < 32) {
    problems.push('WEBSITE_API_KEY must be a long random value (at least 32 characters)');
  }
  if (problems.length) throw new Error(`Not starting: ${problems.join('; ')}`);
}
