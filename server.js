const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
// Cấu hình Socket.IO cho phép kết nối từ mọi nguồn (CORS)
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

const dbConfig = {
    host: 'gateway01.ap-southeast-1.prod.aws.tidbcloud.com', 
    port: 4000,                                              
    user: '3FhqEDAz7EKSUQy.root',                            
    password: 'BHHWN0HDRgNRw3uS',                       
    database: 'icecream_pos',
    ssl: {
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true
    }
};

let pool;

async function initDB() {
    try {
        const connection = await mysql.createConnection({ 
            host: dbConfig.host, 
            user: dbConfig.user, 
            password: dbConfig.password,
            ssl: dbConfig.ssl // Bổ sung cờ bảo mật SSL vào đây
        });
        await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbConfig.database}\`;`);
        await connection.end();

        pool = mysql.createPool(dbConfig);

        // 1. Khởi tạo các bảng chính
        await pool.query(`
            CREATE TABLE IF NOT EXISTS products (
                id VARCHAR(50) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                price INT NOT NULL,
                category VARCHAR(50) NOT NULL,
                stock DECIMAL(10,3) DEFAULT 0
            );
        `);

        try {
            await pool.query(`ALTER TABLE products MODIFY COLUMN stock DECIMAL(10,3) DEFAULT 0;`);
            console.log("🛠️ Đã chuyển đổi cột 'stock' sang kiểu DECIMAL.");
        } catch (e) {}

        await pool.query(`
            CREATE TABLE IF NOT EXISTS orders (
                id VARCHAR(50) PRIMARY KEY,
                total_amount INT NOT NULL,
                payment_method VARCHAR(50) NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS order_details (
                id INT AUTO_INCREMENT PRIMARY KEY,
                order_id VARCHAR(50),
                product_id VARCHAR(50),
                quantity INT NOT NULL,
                unit_price INT NOT NULL,
                deduct_weight DECIMAL(10,3) DEFAULT 0,
                FOREIGN KEY (order_id) REFERENCES orders(id),
                FOREIGN KEY (product_id) REFERENCES products(id)
            );
        `);

        try {
            await pool.query(`ALTER TABLE order_details ADD COLUMN deduct_weight DECIMAL(10,3) DEFAULT 0;`);
            console.log("🛠️ Đã cập nhật thêm cột 'deduct_weight' vào bảng order_details.");
        } catch (e) {}

        // 2. Khởi tạo bảng Nhật ký hệ thống (Audit Logs)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS audit_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                table_name VARCHAR(50) NOT NULL,
                record_id VARCHAR(50) NOT NULL,
                action VARCHAR(20) NOT NULL,
                old_data JSON,
                new_data JSON,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // 3. Khởi tạo bảng Users (Tài khoản)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                username VARCHAR(50) PRIMARY KEY,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(20) NOT NULL
            );
        `);

        // Tự động tạo 3 tài khoản mặc định nếu bảng trống
        const [users] = await pool.query('SELECT * FROM users');
        if (users.length === 0) {
            await pool.query(`
                INSERT INTO users (username, password, role) VALUES 
                ('chuquan', 'chuquan', 'owner'),
                ('admin', 'admin', 'admin'),
                ('nhanvien', '123', 'staff')
            `);
            console.log("🛠️ Đã tạo 3 tài khoản mặc định: chuquan, admin, nhanvien.");
        }

        // [MỚI] ĐÃ GỠ BỎ TOÀN BỘ TRIGGER ĐỂ TƯƠNG THÍCH VỚI TIDB CLOUD

        console.log("✅ Database và các Bảng đã sẵn sàng (Đã cấu hình chuẩn TiDB)!");
    } catch (error) {
        console.error("❌ Lỗi DB:", error);
    }
}

// Xử lý Socket.IO kết nối
io.on('connection', (socket) => {
    console.log('⚡ Một client vừa kết nối:', socket.id);
    socket.on('disconnect', () => {
        console.log('🔥 Một client đã ngắt kết nối:', socket.id);
    });
});

// ================= API SẢN PHẨM =================
app.get('/api/products', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM products');
        res.json(rows);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/products', async (req, res) => {
    const { id, name, price, category, stock } = req.body;
    const currentStock = stock || 0;
    try {
        await pool.query('INSERT INTO products (id, name, price, category, stock) VALUES (?, ?, ?, ?, ?)', 
            [id, name, price, category, currentStock]);
            
        // Ghi log thêm mới
        await pool.query(`INSERT INTO audit_logs (table_name, record_id, action, old_data, new_data) VALUES (?, ?, ?, ?, ?)`, 
            ['products', id, 'INSERT', null, JSON.stringify({ name, price, stock: currentStock })]);

        io.emit('products_updated');
        res.status(201).json({ message: 'Đã thêm món!' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/products/:id', async (req, res) => {
    const { name, price, stock } = req.body;
    const { id } = req.params;
    try {
        // Lấy dữ liệu cũ để ghi log
        const [oldRows] = await pool.query('SELECT * FROM products WHERE id = ?', [id]);
        if (oldRows.length === 0) return res.status(404).json({ message: 'Không tìm thấy sản phẩm' });
        const oldData = oldRows[0];

        let updates = [];
        let params = [];

        if (name !== undefined) { updates.push('name = ?'); params.push(name); }
        if (price !== undefined) { updates.push('price = ?'); params.push(price); }
        if (stock !== undefined) { updates.push('stock = ?'); params.push(stock); }

        if (updates.length === 0) {
            return res.status(400).json({ message: 'Không có dữ liệu để cập nhật' });
        }

        params.push(id);
        
        // Cập nhật sản phẩm
        await pool.query(`UPDATE products SET ${updates.join(', ')} WHERE id = ?`, params);
        
        // Lấy dữ liệu mới và ghi log
        const [newRows] = await pool.query('SELECT * FROM products WHERE id = ?', [id]);
        const newData = newRows[0];

        await pool.query(`INSERT INTO audit_logs (table_name, record_id, action, old_data, new_data) VALUES (?, ?, ?, ?, ?)`, 
            ['products', id, 'UPDATE', JSON.stringify(oldData), JSON.stringify(newData)]);

        io.emit('products_updated');
        res.json({ message: 'Đã cập nhật thông tin món!' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/products/:id', async (req, res) => {
    const { id } = req.params;
    const connection = await pool.getConnection(); 
    try {
        const [oldRows] = await connection.query('SELECT * FROM products WHERE id = ?', [id]);
        const oldData = oldRows.length > 0 ? oldRows[0] : null;

        await connection.query('SET FOREIGN_KEY_CHECKS=0;');
        await connection.query('DELETE FROM products WHERE id = ?', [id]);
        await connection.query('SET FOREIGN_KEY_CHECKS=1;'); 
        
        if (oldData) {
            await connection.query(`INSERT INTO audit_logs (table_name, record_id, action, old_data, new_data) VALUES (?, ?, ?, ?, ?)`, 
                ['products', id, 'DELETE', JSON.stringify(oldData), null]);
        }

        connection.release();
        io.emit('products_updated');
        res.json({ message: 'Đã xóa món!' });
    } catch (error) {
        if (connection) connection.release();
        res.status(500).json({ error: error.message });
    }
});

// ================= API ĐƠN HÀNG =================
app.post('/api/orders', async (req, res) => {
    const { id, total_amount, payment_method, cart_items } = req.body;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        
        const currentDateTime = new Date();
        
        // 1. Tạo hóa đơn
        await connection.query(
            'INSERT INTO orders (id, total_amount, payment_method, created_at) VALUES (?, ?, ?, ?)',
            [id, total_amount, payment_method, currentDateTime]
        );

        // 2. Lưu chi tiết hóa đơn & TỰ ĐỘNG TRỪ KHO (Thay thế Trigger)
        for (const item of cart_items) {
            // Lưu chi tiết đơn
            await connection.query(
                'INSERT INTO order_details (order_id, product_id, quantity, unit_price, deduct_weight) VALUES (?, ?, ?, ?, ?)',
                [id, item.product.id, item.quantity, item.product.price, item.deduct_weight || 0]
            );

            // Tính toán lượng hao hụt
            let deduction_qty = item.quantity; // Mặc định trừ 1
            const pName = (item.product.name || '').toLowerCase(); // Chống lỗi null

            if (pName.includes('kem') && item.deduct_weight > 0) {
                deduction_qty = item.quantity * item.deduct_weight;
            } else if (pName.includes('yaourt') || pName.includes('sữa chua') || pName.includes('yaua')) {
                deduction_qty = item.quantity * 3.0;
            } else if (pName.includes('bơ')) {
                deduction_qty = item.quantity * 0.2;
            } else if (pName.includes('cacao')) {
                deduction_qty = item.quantity * 0.02; // [MỚI] Trừ 20 gram cho Cacao
            }

            // Gửi lệnh trừ trực tiếp vào kho
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
    } finally {
        connection.release();
    }
});

// ================= API NHẬT KÝ (AUDIT LOGS) =================
app.get('/api/audit-logs', async (req, res) => {
    try {
        const { date } = req.query; 
        
        let query = 'SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 50';
        let params = [];

        if (date) {
            query = 'SELECT * FROM audit_logs WHERE DATE(created_at) = ? ORDER BY created_at DESC';
            params.push(date);
        }

        const [rows] = await pool.query(query, params);
        
        const formattedLogs = rows.map(log => ({
            ...log,
            old_data: typeof log.old_data === 'string' ? JSON.parse(log.old_data) : log.old_data,
            new_data: typeof log.new_data === 'string' ? JSON.parse(log.new_data) : log.new_data
        }));

        res.json(formattedLogs);
    } catch (error) {
        console.error("Lỗi tải Audit Logs:", error);
        res.status(500).json({ error: error.message });
    }
});

// Lấy thống kê theo số ngày (1: Hôm nay, 2: 2 ngày gần nhất)
app.get('/api/orders/dashboard', async (req, res) => {
    try {
        const { days = 1 } = req.query; 
        const queryDays = parseInt(days);
        
        let dateQuery = `DATE(created_at) >= CURDATE() - INTERVAL ${queryDays - 1} DAY`;
        if (queryDays === 1) {
             dateQuery = `DATE(created_at) = CURDATE()`;
        }

        const [orders] = await pool.query(`SELECT * FROM orders WHERE ${dateQuery} ORDER BY created_at DESC`);
        
        let totalRevenue = 0;
        let cashRevenue = 0;
        let transferRevenue = 0;

        orders.forEach(order => {
            totalRevenue += order.total_amount;
            if (order.payment_method === 'Tiền mặt') cashRevenue += order.total_amount;
            if (order.payment_method === 'Chuyển khoản') transferRevenue += order.total_amount;
        });

        res.json({
            summary: {
                totalRevenue,
                cashRevenue, 
                transferRevenue
            },
            history: orders
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ================= API TÀI KHOẢN (ĐĂNG NHẬP & ĐỔI PASS) =================
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const [rows] = await pool.query('SELECT * FROM users WHERE username = ? AND password = ?', [username, password]);
        if (rows.length > 0) {
            res.json({ success: true, role: rows[0].role });
        } else {
            res.status(401).json({ success: false, message: 'Sai thông tin đăng nhập' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/users/password', async (req, res) => {
    const { targetRole, newPassword } = req.body;
    try {
        await pool.query('UPDATE users SET password = ? WHERE role = ?', [newPassword, targetRole]);
        res.json({ message: 'Cập nhật mật khẩu thành công!' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

server.listen(PORT, async () => {
    console.log(`🚀 Server (Socket.IO + API) đang chạy tại: http://localhost:${PORT}`);
    await initDB();
});