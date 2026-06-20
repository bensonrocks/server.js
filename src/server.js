require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const clientsRouter = require('./routes/clients');
const roomsRouter = require('./routes/rooms');
const furnitureRouter = require('./routes/furniture');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/clients', clientsRouter);
app.use('/api', roomsRouter);
app.use('/api', furnitureRouter);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Louve Luxe app listening on port ${PORT}`);
});
