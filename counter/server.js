const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// Punctuation stripped from each word's edges for unique-word counting.
const EDGE_PUNCT = '.,!?;:"\'()';

app.use(express.json());

// Log every request to stdout: method, path, status.
app.use((req, res, next) => {
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode}`);
  });
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/count', (req, res) => {
  const text = (req.body || {}).text;
  if (typeof text !== 'string') {
    return res.status(400).json({ error: 'text is required' });
  }

  // Whitespace-tokenized words: split(' ') alone leaves empty strings for
  // leading/trailing/repeated whitespace, so filter them out.
  const words = text.split(' ').filter((w) => w.length > 0);
  const characters = text.length;
  const uniqueWords = new Set(
    words.map((w) =>
      w
        .toLowerCase()
        .replace(new RegExp(`^[${EDGE_PUNCT}]+|[${EDGE_PUNCT}]+$`, 'g'), '')
    )
  ).size;

  res.json({ words: words.length, characters, uniqueWords });
});

app.listen(PORT, () => {
  console.log(`counter listening on port ${PORT}`);
});
