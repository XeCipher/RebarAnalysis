const fs = require('fs');
const path = require('path');

// Protect local development: Only generate the file if running on Vercel
if (!process.env.VERCEL) {
  console.log('Not running on Vercel. Skipping dynamic environment generation.');
  process.exit(0);
}

const targetPath = path.join(__dirname, 'src/environments/environment.ts');

// Create the dynamic environment file content
const envConfigFile = `export const environment = {
  production: true,
  gemprismApiKey: '${process.env.GEMPRISM_API_KEY}',
  gemprismBaseUrl: '${process.env.GEMPRISM_BASE_URL || 'https://gemprism.vercel.app'}',
  apiBaseUrl: '${process.env.API_BASE_URL || 'https://rebaranalysis.onrender.com'}',
  googleAnalyticsId: '${process.env.GOOGLE_ANALYTICS_ID || ''}'
};
`;

// Create the directory and file
fs.mkdirSync(path.join(__dirname, 'src/environments'), { recursive: true });
fs.writeFileSync(targetPath, envConfigFile);
console.log(`Vercel environment file generated dynamically at ${targetPath}`);
