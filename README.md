# Compliance Email Report Generator

Upload store audit PDFs → AI extracts non-compliances, auditor comments, and crops evidence images into a professional email report.

## Deploy to GitHub Pages (Step-by-Step)

### 1. Create a GitHub repo

- Go to [github.com/new](https://github.com/new)
- Name it `compliance-email-report`
- Set it to **Public**
- Click **Create repository**

### 2. Push this code

Open your terminal and run:

```bash
cd compliance-app
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/compliance-email-report.git
git push -u origin main
```

> Replace `YOUR_USERNAME` with your actual GitHub username.

### 3. Enable GitHub Pages

- Go to your repo → **Settings** → **Pages**
- Under **Source**, select **GitHub Actions**
- That's it! The workflow will auto-deploy on every push

### 4. Access your site

After the workflow runs (1-2 min), your app will be live at:

```
https://YOUR_USERNAME.github.io/compliance-email-report/
```

## Local Development

```bash
npm install
npm run dev
```

Opens at `http://localhost:5173`
