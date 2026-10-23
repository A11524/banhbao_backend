const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

const dbConfig = {
    host: 'gateway01.ap-southeast-1.prod.aws.tidbcloud.com', 
    port: 4000,                                              
    user: '3FhqEDAz7EKSUQy.root',                            
    password: 'BHHWN0HDRgNRw3uS',                       
    database: 'banhbao_pos',
    ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true }
};

let pool;

async function initDB() {
    try {
        const connection = await mysql.createConnection({ 
            host: dbConfig.host, user: dbConfig.user, password: dbConfig.password, ssl: dbConfig.ssl 
        });
        await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\`;`);
        await connection.end();

        pool = mysql.createPool(dbConfig);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS products (
                id VARCHAR(50) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                price INT NOT NULL,
                category VARCHAR(50) NOT NULL,
                stock DECIMAL(10,3) DEFAULT 0,
                master_stock DECIMAL(10,3) DEFAULT 0,
                price_2 INT DEFAULT 0,
                price_3 INT DEFAULT 0,
                price_4 INT DEFAULT 0,
                deduct_per_serve DECIMAL(10,3) DEFAULT 1.0
            );
        `);
        try { await pool.query(`ALTER TABLE products ADD COLUMN master_stock DECIMAL(10,3) DEFAULT 0;`); } catch (e) {} // DÒNG MỚI THÊM

        await pool.query(`
            CREATE TABLE IF NOT EXISTS expenses (
                id VARCHAR(50) PRIMARY KEY,
                description VARCHAR(255) NOT NULL,
                amount INT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);

        try { await pool.query(`ALTER TABLE products MODIFY COLUMN stock DECIMAL(10,3) DEFAULT 0;`); } catch (e) {}
        try { await pool.query(`ALTER TABLE products ADD COLUMN price_2 INT DEFAULT 0, ADD COLUMN price_3 INT DEFAULT 0, ADD COLUMN price_4 INT DEFAULT 0;`); } catch (e) {}
        try { 
            await pool.query(`ALTER TABLE products ADD COLUMN deduct_per_serve DECIMAL(10,3) DEFAULT 1.0;`); 
            console.log("🛠️ Đã cập nhật cột định mức trừ kho (deduct_per_serve).");
        } catch (e) {}

        await pool.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id VARCHAR(50) PRIMARY KEY, total_amount INT NOT NULL, payment_method VARCHAR(50) NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS order_details (
                id INT AUTO_INCREMENT PRIMARY KEY, order_id VARCHAR(50), product_id VARCHAR(50), quantity INT NOT NULL, unit_price INT NOT NULL, deduct_weight DECIMAL(10,3) DEFAULT 0,
                FOREIGN KEY (order_id) REFERENCES orders(id), FOREIGN KEY (product_id) REFERENCES products(id)
            );
        `);

        try { await pool.query(`ALTER TABLE order_details ADD COLUMN deduct_weight DECIMAL(10,3) DEFAULT 0;`); } catch (e) {}

        await pool.query(`
            CREATE TABLE IF NOT EXISTS audit_logs (
                id INT AUTO_INCREMENT PRIMARY KEY, table_name VARCHAR(50) NOT NULL, record_id VARCHAR(50) NOT NULL, action VARCHAR(20) NOT NULL, old_data JSON, new_data JSON, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (username VARCHAR(50) PRIMARY KEY, password VARCHAR(255) NOT NULL, role VARCHAR(20) NOT NULL);
        `);

        const [users] = await pool.query('SELECT * FROM users');
        if (users.length === 0) {
            await pool.query(`INSERT INTO users (username, password, role) VALUES ('chuquan', 'chuquan', 'owner'), ('admin', 'admin', 'admin'), ('nhanvien', '123', 'staff')`);
        }
        console.log("✅ Database đã sẵn sàng!");
    } catch (error) { console.error("❌ Lỗi DB:", error); }
}

io.on('connection', (socket) => {
    console.log('⚡ Client kết nối:', socket.id);
    socket.on('disconnect', () => { console.log('🔥 Client ngắt kết nối:', socket.id); });
});

app.get('/api/products', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM products');
        res.json(rows);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/products', async (req, res) => {
    const { id, name, price, category, stock, master_stock, price_2, price_3, price_4, deduct_per_serve } = req.body;
    const currentStock = stock || 0;
    const mStock = master_stock || 0;
    try {
        await pool.query('INSERT INTO products (id, name, price, category, stock, master_stock, price_2, price_3, price_4, deduct_per_serve) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 
            [id, name, price, category, currentStock, mStock, price_2 || 0, price_3 || 0, price_4 || 0, deduct_per_serve || 1.0]);
            
        await pool.query(`INSERT INTO audit_logs (table_name, record_id, action, old_data, new_data) VALUES (?, ?, ?, ?, ?)`, 
            ['products', id, 'INSERT', null, JSON.stringify({ name, price, stock: currentStock, master_stock: mStock })]);

        io.emit('products_updated');
        res.status(201).json({ message: 'Đã thêm món!' });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/products/:id', async (req, res) => {
    const { name, price, stock, price_2, price_3, price_4, deduct_per_serve } = req.body;
    const { id } = req.params;
    try {
        const [oldRows] = await pool.query('SELECT * FROM products WHERE id = ?', [id]);
        if (oldRows.length === 0) return res.status(404).json({ message: 'Không tìm thấy sản phẩm' });
        
        let updates = []; let params = [];
        if (name !== undefined) { updates.push('name = ?'); params.push(name); }
        if (price !== undefined) { updates.push('price = ?'); params.push(price); }
        if (stock !== undefined) { updates.push('stock = ?'); params.push(stock); }
        if (req.body.master_stock !== undefined) { updates.push('master_stock = ?'); params.push(req.body.master_stock); } // DÒNG MỚI THÊM
        if (price_2 !== undefined) { updates.push('price_2 = ?'); params.push(price_2); }
        if (price_3 !== undefined) { updates.push('price_3 = ?'); params.push(price_3); }
        if (price_4 !== undefined) { updates.push('price_4 = ?'); params.push(price_4); }
        if (deduct_per_serve !== undefined) { updates.push('deduct_per_serve = ?'); params.push(deduct_per_serve); }

        if (updates.length === 0) return res.status(400).json({ message: 'Không có dữ liệu cập nhật' });
        params.push(id);
        
        await pool.query(`UPDATE products SET ${updates.join(', ')} WHERE id = ?`, params);
        const [newRows] = await pool.query('SELECT * FROM products WHERE id = ?', [id]);

        await pool.query(`INSERT INTO audit_logs (table_name, record_id, action, old_data, new_data) VALUES (?, ?, ?, ?, ?)`, 
            ['products', id, 'UPDATE', JSON.stringify(oldRows[0]), JSON.stringify(newRows[0])]);

        io.emit('products_updated');
        res.json({ message: 'Đã cập nhật thông tin món!' });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/products/:id', async (req, res) => {
    const { id } = req.params;
    const connection = await pool.getConnection(); 
    try {
        const [oldRows] = await connection.query('SELECT * FROM products WHERE id = ?', [id]);
        await connection.query('SET FOREIGN_KEY_CHECKS=0;');
        await connection.query('DELETE FROM products WHERE id = ?', [id]);
        await connection.query('SET FOREIGN_KEY_CHECKS=1;'); 
        
        if (oldRows.length > 0) {
            await connection.query(`INSERT INTO audit_logs (table_name, record_id, action, old_data, new_data) VALUES (?, ?, ?, ?, ?)`, 
                ['products', id, 'DELETE', JSON.stringify(oldRows[0]), null]);
        }
        connection.release();
        io.emit('products_updated');
        res.json({ message: 'Đã xóa món!' });
    } catch (error) { if (connection) connection.release(); res.status(500).json({ error: error.message }); }
});

app.post('/api/orders', async (req, res) => {
    const { id, total_amount, payment_method, cart_items } = req.body;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const currentDateTime = new Date();
        
        await connection.query(
            'INSERT INTO orders (id, total_amount, payment_method, created_at) VALUES (?, ?, ?, ?)',
            [id, total_amount, payment_method, currentDateTime]
        );

        for (const item of cart_items) {
            await connection.query(
                'INSERT INTO order_details (order_id, product_id, quantity, unit_price, deduct_weight) VALUES (?, ?, ?, ?, ?)',
                [id, item.product.id, item.quantity, item.product.price, item.deduct_weight || 0]
            );

            // Kiểm tra db để lấy định mức trừ kho
            const [pRows] = await connection.query('SELECT name, deduct_per_serve FROM products WHERE id = ?', [item.product.id]);
            let pName = (item.product.name || '').toLowerCase();
            let deductAmount = 1.0;

            if (pRows.length > 0) {
                pName = (pRows[0].name || '').toLowerCase();
                deductAmount = parseFloat(pRows[0].deduct_per_serve) || 1.0;
            }

            // XÓA HẾT MẤY DÒNG IF...ELSE CHỨA CHỮ "kem", "yaourt", "bơ" ĐI.
            // CHỈ GIỮ LẠI NHƯ NÀY:
            let deduction_qty = item.quantity; 
            if (item.deduct_weight > 0) {
                deduction_qty = item.quantity * item.deduct_weight;
            }
            await connection.query(
                'UPDATE products SET stock = stock - ? WHERE id = ?',
                [deduction_qty, item.product.id]
            );
        }

        await connection.commit();
        io.emit('new_order');
        io.emit('products_updated');
        res.status(201).json({ message: 'Thanh toán thành công!' });
    } catch (error) {
        await connection.rollback();
        res.status(500).json({ error: error.message });
    } finally { connection.release(); }
});

app.get('/api/audit-logs', async (req, res) => {
    try {
        const { date } = req.query; 
        let query = 'SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 50';
        let params = [];
        if (date) { 
            // Ép múi giờ: Cộng thêm 7 tiếng vào giờ UTC của Database trước khi so sánh ngày
            query = 'SELECT * FROM audit_logs WHERE DATE(DATE_ADD(created_at, INTERVAL 7 HOUR)) = ? ORDER BY created_at DESC'; 
            params.push(date); 
        }
        const [rows] = await pool.query(query, params);
        res.json(rows);
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/orders/dashboard', async (req, res) => {
    try {
        const { days, startDate, endDate } = req.query; 
        let dateQuery = '';
        let params = [];

        // Ép thời gian truy vấn về múi giờ Việt Nam
        if (startDate && endDate) {
            dateQuery = 'DATE(DATE_ADD(created_at, INTERVAL 7 HOUR)) >= ? AND DATE(DATE_ADD(created_at, INTERVAL 7 HOUR)) <= ?';
            params.push(startDate, endDate);
        } else if (days) {
            const queryDays = parseInt(days);
            dateQuery = queryDays === 1 ? `DATE(DATE_ADD(created_at, INTERVAL 7 HOUR)) = CURDATE()` : `DATE(DATE_ADD(created_at, INTERVAL 7 HOUR)) >= CURDATE() - INTERVAL ${queryDays - 1} DAY`;
        } else {
            dateQuery = 'DATE(DATE_ADD(created_at, INTERVAL 7 HOUR)) = CURDATE()';
        }

        const [orders] = await pool.query(`SELECT * FROM orders WHERE ${dateQuery} ORDER BY created_at DESC`, params);
        
        let orderIds = orders.map(o => o.id);
        let details = [];
        if (orderIds.length > 0) {
            const [rows] = await pool.query(`
                SELECT od.order_id, od.quantity, od.unit_price, p.name 
                FROM order_details od 
                LEFT JOIN products p ON od.product_id = p.id 
                WHERE od.order_id IN (?)
            `, [orderIds]);
            details = rows;
        }

        const ordersWithDetails = orders.map(o => ({
            ...o,
            items: details.filter(d => d.order_id === o.id)
        }));

        let totalRevenue = 0, cashRevenue = 0, transferRevenue = 0;
        orders.forEach(order => {
            totalRevenue += order.total_amount;
            if (order.payment_method === 'Tiền mặt') cashRevenue += order.total_amount;
            if (order.payment_method === 'Chuyển khoản') transferRevenue += order.total_amount;
        });

        res.json({ summary: { totalRevenue, cashRevenue, transferRevenue }, history: ordersWithDetails });
    } catch (error) { 
        res.status(500).json({ error: error.message }); 
    }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await pool.query('SELECT * FROM users WHERE username = ? AND password = ?', [username, password]);
        if (rows.length > 0) res.json({ success: true, role: rows[0].role });
        else res.status(401).json({ success: false, message: 'Sai thông tin đăng nhập' });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

app.put('/api/users/password', async (req, res) => {
    const { targetRole, newPassword } = req.body;
    try {
        await pool.query('UPDATE users SET password = ? WHERE role = ?', [newPassword, targetRole]);
        res.json({ message: 'Cập nhật mật khẩu thành công!' });
    } catch (error) { res.status(500).json({ error: error.message }); }
});

// ================= API CHI PHÍ (EXPENSES) =================
// 1. Lấy danh sách chi phí
app.get('/api/expenses', async (req, res) => {
  try {
      // Đảm bảo lấy theo giờ VN nếu cần, nhưng tạm thời lưu trực tiếp
      const [rows] = await pool.query('SELECT * FROM expenses ORDER BY created_at DESC');
      res.json(rows);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// 2. Thêm phiếu chi mới
app.post('/api/expenses', async (req, res) => {
  try {
      const { id, description, amount } = req.body;
      const currentDateTime = new Date();
      await pool.query('INSERT INTO expenses (id, description, amount, created_at) VALUES (?, ?, ?, ?)', [id, description, amount, currentDateTime]);
      res.status(201).json({ message: "Thêm chi phí thành công" });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// 3. Xóa phiếu chi
app.delete('/api/expenses/:id', async (req, res) => {
  try {
      await pool.query('DELETE FROM expenses WHERE id = ?', [req.params.id]);
      res.json({ message: "Đã xóa chi phí" });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

server.listen(PORT, async () => {
    console.log(`🚀 Server đang chạy tại: http://localhost:${PORT}`);
    await initDB();
});