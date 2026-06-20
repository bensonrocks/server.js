require('dotenv').config();
const prisma = require('../src/lib/prisma');
const { hashPassword } = require('../src/lib/auth');

async function main() {
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  const name = process.env.SEED_ADMIN_NAME || 'Admin';

  if (!email || !password) {
    console.error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD env vars before running this script.');
    process.exitCode = 1;
    return;
  }
  if (password.length < 8) {
    console.error('SEED_ADMIN_PASSWORD must be at least 8 characters.');
    process.exitCode = 1;
    return;
  }

  const normalizedEmail = email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing) {
    console.log(`User ${normalizedEmail} already exists (role: ${existing.role}). Nothing to do.`);
    return;
  }

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({
    data: { email: normalizedEmail, passwordHash, name, role: 'ADMIN' },
  });
  console.log(`Created admin user: ${user.email}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
