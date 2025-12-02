const express = require('express');
const app = express();
const PORT = 3000;

// cho phép đọc JSON từ body
app.use(express.json());

// route test
app.get('/', (req, res) => {
  res.send('API Node.js chạy ngon!');
});

// route ví dụ lấy danh sách user giả
app.get('/users', (req, res) => {
  res.json([
    { id: 1, name: 'duchx' },
    { id: 2, name: 'quannh' },
  ]);
});

app.listen(PORT, () => {
  console.log(`Server chạy tại http://localhost:${PORT}`);
});
