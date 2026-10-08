import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { pool } from './db.js';
import { authenticate, requireRole } from './middleware.js';

const app = express();
const PORT = Number(process.env.PORT || 5000);
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173' }));
app.use(express.json({ limit: '7mb' }));

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const validEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''));
const setting = async (key) => {
  const [rows] = await pool.execute('SELECT setting_value FROM settings WHERE setting_key = ?', [key]);
  return rows[0]?.setting_value ?? null;
};
const writeAudit = async (req, action, entityType, entityId = null, details = {}) => {
  await pool.execute(
    'INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
    [req.user?.id || null, action, entityType, entityId == null ? null : String(entityId), JSON.stringify(details), req.ip]
  );
};

app.get('/api/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok', service: 'Govt High School Kot Rafique API' });
}));

app.get('/api/public/site', asyncRoute(async (_req, res) => {
  const [announcements] = await pool.execute(
    'SELECT id, title, body, created_at FROM announcements WHERE published = TRUE AND audience = ? OR published = TRUE AND audience = ? ORDER BY created_at DESC LIMIT 8',
    ['all', 'students']
  );
  res.json({
    schoolName: await setting('school_name'),
    admissionsOpen: (await setting('admissions_open')) === 'true',
    admissionNotice: await setting('admission_notice'),
    announcements
  });
}));

app.post('/api/auth/setup-admin', asyncRoute(async (req, res) => {
  const { setupSecret, fullName, email, password } = req.body || {};
  if (!process.env.ADMIN_SETUP_SECRET || process.env.ADMIN_SETUP_SECRET.startsWith('replace-')) {
    return res.status(503).json({ message: 'Set a private ADMIN_SETUP_SECRET in backend/.env first.' });
  }
  const suppliedSecret = Buffer.from(String(setupSecret || ''), 'utf8');
  const expectedSecret = Buffer.from(String(process.env.ADMIN_SETUP_SECRET), 'utf8');
  if (suppliedSecret.length !== expectedSecret.length || !crypto.timingSafeEqual(suppliedSecret, expectedSecret)) {
    return res.status(403).json({ message: 'Setup secret is incorrect.' });
  }
  const [existing] = await pool.execute("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  if (existing.length) return res.status(409).json({ message: 'First-admin setup is already locked.' });
  if (!fullName?.trim() || !validEmail(email) || typeof password !== 'string' || password.length < 12) {
    return res.status(400).json({ message: 'Enter your name, a valid email, and a password of at least 12 characters.' });
  }
  const hash = await bcrypt.hash(password, 12);
  const [result] = await pool.execute(
    "INSERT INTO users (full_name, email, password_hash, role) VALUES (?, ?, ?, 'admin')",
    [fullName.trim(), email.trim().toLowerCase(), hash]
  );
  res.status(201).json({ message: 'First admin created. You can now log in.', userId: result.insertId });
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  if (!validEmail(email) || typeof password !== 'string') return res.status(400).json({ message: 'Enter a valid email and password.' });
  const [rows] = await pool.execute(
    'SELECT id, full_name, email, password_hash, role, is_active, class_name, section_name FROM users WHERE email = ? LIMIT 1',
    [email.trim().toLowerCase()]
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ message: 'Email or password is incorrect.' });
  }
  if (!user.is_active) return res.status(403).json({ message: 'Your account is awaiting school admin approval or has been deactivated.' });
  const token = jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.full_name, fullName: user.full_name, className: user.class_name || '', sectionName: user.section_name || 'A' }, process.env.JWT_SECRET, { expiresIn: '8h' });
  res.json({ token, user: { id: user.id, fullName: user.full_name, email: user.email, role: user.role, className: user.class_name || '', sectionName: user.section_name || 'A' } });
}));

app.get('/api/auth/me', authenticate, asyncRoute(async (req, res) => {
  const [rows] = await pool.execute('SELECT id, full_name, email, role, class_name, section_name FROM users WHERE id = ? AND is_active = TRUE', [req.user.id]);
  if (!rows[0]) return res.status(401).json({ message: 'Account is not active.' });
  const u = rows[0];
  res.json({ id: u.id, fullName: u.full_name, email: u.email, role: u.role, className: u.class_name || '', sectionName: u.section_name || 'A' });
}));

app.post('/api/admissions', asyncRoute(async (req, res) => {
  if ((await setting('admissions_open')) !== 'true') return res.status(403).json({ message: 'Admissions are currently closed.' });
  const b = req.body || {};
  const required = ['studentName','dateOfBirth','gender','applyingClass','guardianName','guardianRelation','guardianPhone','address'];
  if (required.some(k => !String(b[k] || '').trim())) return res.status(400).json({ message: 'Please complete all required fields.' });
  if (!['male','female','other'].includes(b.gender)) return res.status(400).json({ message: 'Select a valid gender option.' });
  if (b.guardianEmail && !validEmail(b.guardianEmail)) return res.status(400).json({ message: 'Guardian email is not valid.' });
  const applicationNo = `GHSKR-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  await pool.execute(
    `INSERT INTO admission_applications
    (application_no, student_name, date_of_birth, gender, applying_class, previous_school, guardian_name, guardian_relation, guardian_phone, guardian_email, address)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [applicationNo, b.studentName.trim(), b.dateOfBirth, b.gender, b.applyingClass, b.previousSchool?.trim() || null,
     b.guardianName.trim(), b.guardianRelation.trim(), b.guardianPhone.trim(), b.guardianEmail?.trim() || null, b.address.trim()]
  );
  res.status(201).json({ message: 'Application submitted successfully. Keep your application number safe.', applicationNo });
}));

app.get('/api/admin/overview', authenticate, requireRole('admin'), asyncRoute(async (_req, res) => {
  const [[{ totalApplications }]] = await pool.query('SELECT COUNT(*) AS totalApplications FROM admission_applications');
  const [[{ pendingApplications }]] = await pool.query("SELECT COUNT(*) AS pendingApplications FROM admission_applications WHERE status IN ('pending','under_review')");
  const [[{ totalUsers }]] = await pool.query('SELECT COUNT(*) AS totalUsers FROM users');
  const [[{ totalAnnouncements }]] = await pool.query('SELECT COUNT(*) AS totalAnnouncements FROM announcements');
  res.json({ totalApplications, pendingApplications, totalUsers, totalAnnouncements, admissionsOpen: (await setting('admissions_open')) === 'true' });
}));

app.get('/api/admin/admissions', authenticate, requireRole('admin'), asyncRoute(async (req, res) => {
  const status = String(req.query.status || '');
  const allowed = ['pending','under_review','approved','rejected'];
  const [rows] = status && allowed.includes(status)
    ? await pool.execute('SELECT * FROM admission_applications WHERE status = ? ORDER BY submitted_at DESC LIMIT 200', [status])
    : await pool.execute('SELECT * FROM admission_applications ORDER BY submitted_at DESC LIMIT 200');
  res.json(rows);
}));

app.patch('/api/admin/admissions/:id/status', authenticate, requireRole('admin'), asyncRoute(async (req, res) => {
  const { status, adminNotes = '' } = req.body || {};
  if (!['pending','under_review','approved','rejected'].includes(status)) return res.status(400).json({ message: 'Invalid application status.' });
  const [result] = await pool.execute(
    'UPDATE admission_applications SET status = ?, admin_notes = ?, reviewed_at = CURRENT_TIMESTAMP, reviewed_by = ? WHERE id = ?',
    [status, String(adminNotes).slice(0, 4000), req.user.id, req.params.id]
  );
  if (!result.affectedRows) return res.status(404).json({ message: 'Application not found.' });
  await writeAudit(req, 'admission_status_changed', 'admission_application', req.params.id, { status });
  res.json({ message: 'Application status updated.' });
}));

app.patch('/api/admin/admissions-settings', authenticate, requireRole('admin'), asyncRoute(async (req, res) => {
  const { open, notice = '' } = req.body || {};
  if (typeof open !== 'boolean') return res.status(400).json({ message: 'Open must be true or false.' });
  await pool.execute('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [String(open), 'admissions_open']);
  await pool.execute('UPDATE settings SET setting_value = ? WHERE setting_key = ?', [String(notice).slice(0, 1000), 'admission_notice']);
  await writeAudit(req, open ? 'admissions_opened' : 'admissions_closed', 'settings');
  res.json({ message: open ? 'Admissions are now open.' : 'Admissions are now closed.', admissionsOpen: open });
}));

app.get('/api/admin/announcements', authenticate, requireRole('admin'), asyncRoute(async (_req, res) => {
  const [rows] = await pool.execute('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 100');
  res.json(rows);
}));

app.post('/api/admin/announcements', authenticate, requireRole('admin'), asyncRoute(async (req, res) => {
  const { title, body, audience = 'all', published = true } = req.body || {};
  if (!title?.trim() || !body?.trim()) return res.status(400).json({ message: 'Title and announcement text are required.' });
  if (!['all','students','teachers'].includes(audience)) return res.status(400).json({ message: 'Invalid audience.' });
  const [result] = await pool.execute(
    'INSERT INTO announcements (title, body, audience, published, created_by) VALUES (?, ?, ?, ?, ?)',
    [title.trim(), body.trim(), audience, Boolean(published), req.user.id]
  );
  await writeAudit(req, 'announcement_created', 'announcement', result.insertId);
  res.status(201).json({ message: 'Announcement published.', id: result.insertId });
}));



// Public student/teacher registration. Teacher accounts are created inactive until an administrator approves them.
app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const { fullName, email, password, role = 'student', className = '', sectionName = 'A' } = req.body || {};
  if (!fullName?.trim() || !validEmail(email) || typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ message: 'Enter your name, a valid email, and a password of at least 8 characters.' });
  }
  if (!['student', 'teacher'].includes(role)) return res.status(400).json({ message: 'Choose student or teacher registration.' });
  const hash = await bcrypt.hash(password, 12);
  const [result] = await pool.execute(
    'INSERT INTO users (full_name, email, password_hash, role, is_active, class_name, section_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [fullName.trim(), email.trim().toLowerCase(), hash, role, role === 'student', className.trim() || null, String(sectionName || 'A').trim() || 'A']
  );
  res.status(201).json({ message: role === 'teacher' ? 'Teacher account submitted. Please wait for admin approval before login.' : 'Student account created. You can now log in.', userId: result.insertId });
}));

app.delete('/api/admin/announcements/:id', authenticate, requireRole('admin'), asyncRoute(async (req, res) => {
  const [result] = await pool.execute('DELETE FROM announcements WHERE id = ?', [req.params.id]);
  if (!result.affectedRows) return res.status(404).json({ message: 'Announcement not found.' });
  await writeAudit(req, 'announcement_deleted', 'announcement', req.params.id);
  res.json({ message: 'Announcement deleted.' });
}));

app.get('/api/admin/users', authenticate, requireRole('admin'), asyncRoute(async (_req, res) => {
  const [rows] = await pool.execute("SELECT id, full_name, email, role, is_active, class_name, created_at FROM users WHERE role IN ('student','teacher') ORDER BY created_at DESC LIMIT 500");
  res.json(rows);
}));
app.patch('/api/admin/users/:id/active', authenticate, requireRole('admin'), asyncRoute(async (req, res) => {
  const active = req.body?.active;
  if (typeof active !== 'boolean') return res.status(400).json({ message: 'Active must be true or false.' });
  const [result] = await pool.execute("UPDATE users SET is_active = ? WHERE id = ? AND role IN ('student','teacher')", [active, req.params.id]);
  if (!result.affectedRows) return res.status(404).json({ message: 'Student/teacher account not found.' });
  await writeAudit(req, active ? 'user_activated' : 'user_deactivated', 'user', req.params.id);
  res.json({ message: active ? 'Account approved/activated.' : 'Account deactivated.' });
}));

app.get('/api/learning/quizzes', authenticate, asyncRoute(async (req, res) => {
  const [quizzes] = await pool.execute('SELECT q.id, q.title, q.description, q.class_name, q.created_at, u.full_name AS teacher_name FROM quizzes q JOIN users u ON u.id=q.teacher_id WHERE q.published=TRUE ORDER BY q.created_at DESC');
  for (const quiz of quizzes) {
    const [questions] = await pool.execute('SELECT id, question_text, option_a, option_b, option_c, option_d FROM quiz_questions WHERE quiz_id=? ORDER BY id', [quiz.id]);
    quiz.questions = questions;
    const [attempts] = await pool.execute('SELECT id, score, total_questions, submitted_at FROM quiz_attempts WHERE quiz_id=? AND student_id=? ORDER BY submitted_at DESC LIMIT 1', [quiz.id, req.user.id]);
    quiz.lastAttempt = attempts[0] || null;
  }
  res.json(quizzes);
}));

app.post('/api/learning/quizzes', authenticate, requireRole('teacher'), asyncRoute(async (req, res) => {
  const { title, description = '', className = '', questions = [] } = req.body || {};
  if (!title?.trim() || !Array.isArray(questions) || questions.length < 1 || questions.length > 30) return res.status(400).json({ message: 'Enter a quiz title and 1–30 questions.' });
  for (const q of questions) {
    if (!q.questionText?.trim() || !['A','B','C','D'].includes(q.correctOption) || ['A','B','C','D'].some(k => !String(q['option'+k]?.trim()))) return res.status(400).json({ message: 'Each question needs text, four options, and a correct option.' });
  }
  const [created] = await pool.execute('INSERT INTO quizzes (teacher_id,title,description,class_name,published) VALUES (?,?,?,?,TRUE)', [req.user.id,title.trim(),String(description).trim(),String(className).trim()||null]);
  for (const q of questions) await pool.execute('INSERT INTO quiz_questions (quiz_id,question_text,option_a,option_b,option_c,option_d,correct_option) VALUES (?,?,?,?,?,?,?)', [created.insertId,q.questionText.trim(),q.optionA.trim(),q.optionB.trim(),q.optionC.trim(),q.optionD.trim(),q.correctOption]);
  res.status(201).json({ message: 'Quiz published.', id: created.insertId });
}));

app.post('/api/learning/quizzes/:id/attempt', authenticate, requireRole('student'), asyncRoute(async (req, res) => {
  const answers = req.body?.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return res.status(400).json({ message: 'Submit your answers.' });
  const [quizRows] = await pool.execute('SELECT id FROM quizzes WHERE id=? AND published=TRUE', [req.params.id]);
  if (!quizRows.length) return res.status(404).json({ message: 'Quiz not found.' });
  const [questions] = await pool.execute('SELECT id, correct_option FROM quiz_questions WHERE quiz_id=?', [req.params.id]);
  const score = questions.reduce((sum,q)=>sum+(answers[q.id]===q.correct_option?1:0),0);
  await pool.execute('INSERT INTO quiz_attempts (quiz_id,student_id,score,total_questions,answers_json) VALUES (?,?,?,?,?)', [req.params.id,req.user.id,score,questions.length,JSON.stringify(answers)]);
  res.json({ message: 'Quiz submitted.', score, totalQuestions: questions.length, percentage: questions.length ? Math.round(score/questions.length*100) : 0 });
}));

app.get('/api/learning/results', authenticate, asyncRoute(async (req, res) => {
  const sql = req.user.role === 'student'
    ? 'SELECT a.id, a.score, a.total_questions, a.submitted_at, q.title FROM quiz_attempts a JOIN quizzes q ON q.id=a.quiz_id WHERE a.student_id=? ORDER BY a.submitted_at DESC'
    : req.user.role === 'teacher'
      ? 'SELECT a.id, a.score, a.total_questions, a.submitted_at, q.title, u.full_name AS student_name FROM quiz_attempts a JOIN quizzes q ON q.id=a.quiz_id JOIN users u ON u.id=a.student_id WHERE q.teacher_id=? ORDER BY a.submitted_at DESC'
      : 'SELECT a.id, a.score, a.total_questions, a.submitted_at, q.title, u.full_name AS student_name FROM quiz_attempts a JOIN quizzes q ON q.id=a.quiz_id JOIN users u ON u.id=a.student_id ORDER BY a.submitted_at DESC';
  const [rows] = await pool.execute(sql, req.user.role === 'admin' ? [] : [req.user.id]);
  res.json(rows);
}));

app.get('/api/learning/guidance', authenticate, asyncRoute(async (req, res) => {
  const [rows] = await pool.execute("SELECT g.id, g.message, g.created_at, u.full_name AS teacher_name FROM teacher_guidance g JOIN users u ON u.id=g.teacher_id WHERE g.audience='all' OR g.audience=? ORDER BY g.created_at DESC LIMIT 100", [req.user.role === 'student' ? 'students' : req.user.role === 'teacher' ? 'teachers' : 'all']);
  res.json(rows);
}));
app.post('/api/learning/guidance', authenticate, requireRole('teacher'), asyncRoute(async (req, res) => {
  const { message, audience = 'students' } = req.body || {};
  if (!message?.trim() || !['all','students'].includes(audience)) return res.status(400).json({ message: 'Enter guidance text and a valid audience.' });
  const [result] = await pool.execute('INSERT INTO teacher_guidance (teacher_id,message,audience) VALUES (?,?,?)', [req.user.id,message.trim(),audience]);
  res.status(201).json({ message: 'Guidance shared with students.', id: result.insertId });
}));


// Attendance: teachers mark records for their class; students can only see their own records.
app.get('/api/school/attendance', authenticate, asyncRoute(async (req, res) => {
  if (req.user.role === 'student') {
    const [rows] = await pool.execute('SELECT attendance_date, status, note FROM attendance_records WHERE student_id=? ORDER BY attendance_date DESC LIMIT 365', [req.user.id]);
    const total = rows.length; const present = rows.filter(r => r.status === 'present' || r.status === 'late').length;
    return res.json({ records: rows, total, present, percentage: total ? Math.round(present / total * 100) : 0 });
  }
  if (req.user.role === 'teacher') {
    const [students] = await pool.execute("SELECT id, full_name, class_name, section_name FROM users WHERE role='student' AND is_active=TRUE AND class_name = (SELECT class_name FROM users WHERE id=?) AND COALESCE(section_name,'A') = (SELECT COALESCE(section_name,'A') FROM users WHERE id=?) ORDER BY full_name", [req.user.id, req.user.id]);
    const [rows] = await pool.execute('SELECT a.*, u.full_name AS student_name FROM attendance_records a JOIN users u ON u.id=a.student_id WHERE a.teacher_id=? ORDER BY a.attendance_date DESC LIMIT 500', [req.user.id]);
    return res.json({ students, records: rows });
  }
  const [rows] = await pool.execute('SELECT a.*, u.full_name AS student_name FROM attendance_records a JOIN users u ON u.id=a.student_id ORDER BY a.attendance_date DESC LIMIT 500');
  res.json({ records: rows });
}));

app.post('/api/school/attendance', authenticate, requireRole('teacher'), asyncRoute(async (req, res) => {
  const { attendanceDate, records } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(attendanceDate || '')) || !Array.isArray(records) || !records.length) return res.status(400).json({ message: 'Choose a date and mark at least one student.' });
  const [teacherRows] = await pool.execute('SELECT class_name FROM users WHERE id=?', [req.user.id]);
  const className = teacherRows[0]?.class_name;
  if (!className) return res.status(400).json({ message: 'Ask the admin to assign your class before marking attendance.' });
  for (const item of records) {
    if (!Number.isInteger(Number(item.studentId)) || !['present','absent','late'].includes(item.status)) continue;
    const [students] = await pool.execute("SELECT id FROM users WHERE id=? AND role='student' AND class_name=? AND COALESCE(section_name,'A')=COALESCE((SELECT section_name FROM users WHERE id=?),'A') AND is_active=TRUE", [item.studentId, className, req.user.id]);
    if (!students.length) continue;
    await pool.execute(`INSERT INTO attendance_records (student_id,teacher_id,class_name,attendance_date,status,note) VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE teacher_id=VALUES(teacher_id),class_name=VALUES(class_name),status=VALUES(status),note=VALUES(note)`, [item.studentId, req.user.id, className, attendanceDate, item.status, String(item.note || '').slice(0,500)]);
  }
  res.json({ message: 'Attendance saved.' });
}));

// Assignment posts and file submissions (max 5 MB per file).
app.get('/api/school/assignments', authenticate, asyncRoute(async (req, res) => {
  if (req.user.role === 'teacher') {
    const [rows] = await pool.execute('SELECT a.*, (SELECT COUNT(*) FROM assignment_submissions s WHERE s.assignment_id=a.id) AS submissions FROM assignments a WHERE a.teacher_id=? ORDER BY a.created_at DESC', [req.user.id]);
    return res.json(rows);
  }
  if (req.user.role === 'student') {
    const [rows] = await pool.execute(`SELECT a.id,a.title,a.instructions,a.class_name,a.due_date,a.created_at,u.full_name AS teacher_name,s.id AS submission_id,s.original_filename,s.submitted_at,s.marks,s.feedback FROM assignments a JOIN users u ON u.id=a.teacher_id LEFT JOIN assignment_submissions s ON s.assignment_id=a.id AND s.student_id=? WHERE a.class_name=? ORDER BY a.due_date IS NULL,a.due_date ASC,a.created_at DESC`, [req.user.id, req.user.className || '']);
    return res.json(rows);
  }
  const [rows] = await pool.execute('SELECT a.*,u.full_name AS teacher_name FROM assignments a JOIN users u ON u.id=a.teacher_id ORDER BY a.created_at DESC');
  res.json(rows);
}));

app.post('/api/school/assignments', authenticate, requireRole('teacher'), asyncRoute(async (req, res) => {
  const { title, instructions, className, dueDate = null } = req.body || {};
  if (!title?.trim() || !instructions?.trim() || !String(className || '').trim()) return res.status(400).json({ message: 'Title, instructions and class are required.' });
  const [teacherRows] = await pool.execute('SELECT class_name FROM users WHERE id=?', [req.user.id]);
  if (teacherRows[0]?.class_name && teacherRows[0].class_name !== String(className).trim()) return res.status(403).json({ message: 'You can only create assignments for your assigned class.' });
  const [result] = await pool.execute('INSERT INTO assignments (teacher_id,title,instructions,class_name,due_date) VALUES (?,?,?,?,?)', [req.user.id,title.trim(),instructions.trim(),String(className).trim(),dueDate || null]);
  res.status(201).json({ message: 'Assignment published.', id: result.insertId });
}));

app.post('/api/school/assignments/:id/submit', authenticate, requireRole('student'), asyncRoute(async (req, res) => {
  const { fileName, mimeType, fileBase64 } = req.body || {};
  if (!fileName || !mimeType || typeof fileBase64 !== 'string') return res.status(400).json({ message: 'Choose a file to upload.' });
  const raw = fileBase64.replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length || buffer.length > 5 * 1024 * 1024) return res.status(400).json({ message: 'File must be smaller than 5 MB.' });
  const [assignments] = await pool.execute('SELECT id,class_name,due_date FROM assignments WHERE id=?', [req.params.id]);
  if (!assignments.length || assignments[0].class_name !== String(req.user.className || '')) return res.status(404).json({ message: 'Assignment not found for your class.' });
  await pool.execute(`INSERT INTO assignment_submissions (assignment_id,student_id,original_filename,file_mime,file_data) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE original_filename=VALUES(original_filename),file_mime=VALUES(file_mime),file_data=VALUES(file_data),submitted_at=CURRENT_TIMESTAMP,marks=NULL,feedback=NULL,graded_by=NULL,graded_at=NULL`, [req.params.id,req.user.id,String(fileName).slice(0,255),String(mimeType).slice(0,120),buffer]);
  res.status(201).json({ message: 'Assignment uploaded successfully.' });
}));

app.get('/api/school/assignments/:id/submissions/:studentId/file', authenticate, asyncRoute(async (req, res) => {
  const [rows] = await pool.execute('SELECT s.original_filename,s.file_mime,s.file_data,a.teacher_id FROM assignment_submissions s JOIN assignments a ON a.id=s.assignment_id WHERE s.assignment_id=? AND s.student_id=?', [req.params.id,req.params.studentId]);
  if (!rows.length || !(req.user.role === 'admin' || (req.user.role === 'teacher' && rows[0].teacher_id === req.user.id) || (req.user.role === 'student' && String(req.user.id) === String(req.params.studentId)))) return res.status(403).json({ message: 'You cannot access this submission.' });
  res.setHeader('Content-Type', rows[0].file_mime); res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(rows[0].original_filename)}`); res.send(rows[0].file_data);
}));

app.get('/api/school/assignments/:id/submissions', authenticate, asyncRoute(async (req, res) => {
  const [assignment] = await pool.execute('SELECT teacher_id FROM assignments WHERE id=?', [req.params.id]);
  if (!assignment.length || !(req.user.role === 'admin' || (req.user.role === 'teacher' && assignment[0].teacher_id === req.user.id))) return res.status(403).json({ message: 'You cannot review these submissions.' });
  const [rows] = await pool.execute('SELECT s.id,s.student_id,s.original_filename,s.submitted_at,s.marks,s.feedback,u.full_name AS student_name FROM assignment_submissions s JOIN users u ON u.id=s.student_id WHERE s.assignment_id=? ORDER BY s.submitted_at DESC', [req.params.id]);
  res.json(rows);
}));

app.patch('/api/school/submissions/:id/grade', authenticate, requireRole('teacher'), asyncRoute(async (req, res) => {
  const { marks, feedback = '' } = req.body || {};
  if (marks === '' || marks == null || !Number.isFinite(Number(marks)) || Number(marks) < 0 || Number(marks) > 100) return res.status(400).json({ message: 'Marks must be between 0 and 100.' });
  const [result] = await pool.execute('UPDATE assignment_submissions s JOIN assignments a ON a.id=s.assignment_id SET s.marks=?,s.feedback=?,s.graded_by=?,s.graded_at=CURRENT_TIMESTAMP WHERE s.id=? AND a.teacher_id=?', [Number(marks),String(feedback).slice(0,4000),req.user.id,req.params.id,req.user.id]);
  if (!result.affectedRows) return res.status(404).json({ message: 'Submission not found for your assignments.' });
  res.json({ message: 'Assignment result saved.' });
}));

// Admin creates class/section-specific timetable entries. Students only see their own class timetable.
app.get('/api/school/timetable', authenticate, asyncRoute(async (req, res) => {
  let sql = 'SELECT * FROM school_timetable'; let args = [];
  if (req.user.role === 'student') { sql += ' WHERE class_name=? AND section_name=?'; args = [req.user.className || '', req.user.sectionName || 'A']; }
  else if (req.user.role === 'teacher') { sql += ' WHERE teacher_name=?'; args = [req.user.fullName || req.user.name || '']; }
  sql += " ORDER BY FIELD(day_of_week,'Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'),start_time";
  const [rows] = await pool.execute(sql,args); res.json(rows);
}));

app.post('/api/admin/timetable', authenticate, requireRole('admin'), asyncRoute(async (req, res) => {
  const { className, sectionName='A', dayOfWeek, startTime, endTime, subject, teacherName, room='' } = req.body || {};
  if (![className,dayOfWeek,startTime,endTime,subject,teacherName].every(v=>String(v||'').trim())) return res.status(400).json({ message: 'Complete class, day, time, subject and teacher fields.' });
  if (!['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].includes(dayOfWeek) || startTime >= endTime) return res.status(400).json({ message: 'Select a valid day and time range.' });
  const [result] = await pool.execute('INSERT INTO school_timetable (class_name,section_name,day_of_week,start_time,end_time,subject,teacher_name,room,created_by) VALUES (?,?,?,?,?,?,?,?,?)', [String(className).trim(),String(sectionName).trim()||'A',dayOfWeek,startTime,endTime,String(subject).trim(),String(teacherName).trim(),String(room).trim()||null,req.user.id]);
  res.status(201).json({ message: 'Timetable entry added.', id: result.insertId });
}));
app.delete('/api/admin/timetable/:id', authenticate, requireRole('admin'), asyncRoute(async (req, res) => {
  const [result] = await pool.execute('DELETE FROM school_timetable WHERE id=?',[req.params.id]);
  if (!result.affectedRows) return res.status(404).json({ message: 'Timetable entry not found.' });
  res.json({ message: 'Timetable entry deleted.' });
}));

app.use((err, _req, res, _next) => {
  console.error(err);
  if (err?.code === 'ER_DUP_ENTRY') return res.status(409).json({ message: 'That email or application identifier already exists.' });
  res.status(500).json({ message: 'Server error. Check backend terminal for details.' });
});

app.listen(PORT, () => console.log(`School API listening on http://localhost:${PORT}`));
