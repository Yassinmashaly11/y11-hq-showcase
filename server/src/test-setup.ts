// The API tests use a separate database so they never touch your real data.
import 'dotenv/config';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/y11hq_test';
process.env.JWT_SECRET = 'test-secret';
