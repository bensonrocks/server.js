require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');

const authRouter = require('./routes/auth');
const clientsRouter = require('./routes/clients');
const roomsRouter = require('./routes/rooms');
const furnitureRouter = require('./routes/furniture');
const { requireAuth } = require('./middleware/requireAuth');

if (!process.env.SESSION_SECRET) {
  throw new Error('Missing SESSION_SECRET env var. See .env.example for setup.');
}

const app = express();
const sessionPool = new Pool({ connectionString: process.env.DATABASE_URL });

app.use(cors());
app.use(express.json());
app.use(
  session({
    store: new pgSession({ pool: sessionPool, createTableIfMissing: true }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    },
  })
);
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authRouter);
app.use('/api/clients', requireAuth, clientsRouter);
app.use('/api', requireAuth, roomsRouter);
app.use('/api', requireAuth, furnitureRouter);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Louve Luxe app listening on port ${PORT}`);
});
