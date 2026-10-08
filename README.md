# Govt High School Kot Rafique — School Management System

A responsive starter application with a React/Vite frontend, Express API, and MySQL database.

## Included in this build
- Public school homepage with announcements and admission status
- Public student admission application form
- First-admin setup protected by a one-time setup secret
- Secure password hashing with bcrypt
- JWT login and role-based API authorization
- Admin dashboard: admission open/close, view applications, update application status
- Student and teacher registration/login with role-based dashboards
- Student quiz attempts, automatic MCQ scoring, and performance history
- Teacher quiz creation, result review, and student guidance posts
- Teacher attendance marking (Present, Absent, Late) and student attendance history/percentage
- Teacher assignment publishing with due dates, student file upload (5 MB limit), teacher download, marking and feedback
- Class/section timetable management for admin; students and teachers see relevant timetable entries
- Admin announcement deletion and student/teacher account approval
- MySQL schema and seed defaults
- Basic responsive design for mobile and desktop

## Important
Learning portal note: quizzes currently use multiple-choice questions (four options) and automatic scoring. Teacher registration is held for admin approval. This is a development starter, not a finished production deployment. Before real student data is used, configure HTTPS, backups, email/SMS delivery, rate limiting, monitoring, school privacy/consent procedures, and test the system with sample data. Do not expose this development server directly to the public internet.

## Requirements
- Node.js 20+ (LTS recommended)
- MySQL 8+
- VS Code

## 1. Create database
Open MySQL Workbench and run `backend/database/schema.sql`, then run `backend/database/upgrade-learning-portal.sql` once. The upgrade script creates the learning, attendance, assignment/submission and timetable tables and adds the section field. Do not run the upgrade script a second time because it adds a database column.

## 2. Configure backend
Open a terminal:
```powershell
cd backend
Copy-Item .env.example .env
```
Edit `.env` with your local MySQL username and password. Change `JWT_SECRET` to a long random secret and set `ADMIN_SETUP_SECRET` to a long one-time setup phrase that you keep private.

Install and start:
```powershell
npm install
npm run dev
```
API runs on `http://localhost:5000`.

## 3. Configure frontend
Open a second terminal:
```powershell
cd frontend
Copy-Item .env.example .env
npm install
npm run dev
```
Open the URL Vite prints (normally `http://localhost:5173`).

## 4. Create first admin
While backend is running, open a browser or use the setup form on the frontend:
- Visit `http://localhost:5173/setup-admin`
- Enter the exact `ADMIN_SETUP_SECRET` from `backend/.env`
- Enter admin name, email, and a strong password.
- The setup secret is disabled automatically after the first admin is created.

Never share the setup secret or admin password. If the first-admin setup endpoint is already locked, an admin already exists.

## 5. First use
- Log in at `/login`
- Open the Dashboard; each account automatically receives the dashboard for its server-assigned role.
- Admin can use Admissions, delete announcements, and approve/deactivate accounts. The admin setup link is not displayed on the public login page; keep the setup secret private.
- Teachers must be approved by admin, then can publish quizzes and assignments, mark attendance for students in their assigned class/section, review submissions, give marks/feedback and share guidance. Students can attempt quizzes, upload assignment files (up to 5 MB), view results/feedback and check their attendance and class timetable.
- Admin can create and delete class/section timetable entries. Student accounts should use the correct class and section during registration so the timetable matches.
- Public visitors can submit an admission application from the homepage while admissions are open.

## Folder structure
- `frontend/` — React + Vite UI
- `backend/` — Express API
- `backend/database/schema.sql` — MySQL tables and initial settings

## Security notes
- Passwords are bcrypt-hashed.
- SQL uses parameterized queries.
- API endpoints enforce roles on the server.
- Student applications contain personal information: restrict database access and only collect information needed by the school.
- This starter does not yet implement production-grade email verification, password-reset email delivery, MFA, or deployment automation. Assignment uploads are stored in MySQL and are limited to 5 MB per file.
