# EdgeVault

EdgeVault is a static trading journal with an Express API, MongoDB-backed accounts and journal storage, and a Netlify Functions deployment.

## Run locally

1. Install dependencies with `npm install`.
2. Copy `.env.example` to `.env` and set `MONGODB_URI`, `MONGODB_DB_NAME`, and a long random `SESSION_SECRET`.
3. Start the app with `npm start`, then open `http://localhost:3000`.

The local Express server serves the frontend and API together. Journal data is stored as a JSON document per user in MongoDB; the required database and indexes are created when the API initializes. Keep `.env` private and never commit it.

## Deploy to Netlify

1. Push the project to a Git provider and import it as a site in Netlify.
2. In **Site configuration → Environment variables**, add the variables below for the Functions runtime. Set them before deploying or trigger a new deploy after changing them.
3. Deploy. `netlify.toml` publishes the project root and bundles the API function from `netlify/functions/api.js`. Netlify's forced `/api` redirects route API requests to the function while static files continue to be served from the root.

Required Netlify environment variables:

| Variable | Value |
| --- | --- |
| `MONGODB_URI` | Your MongoDB Atlas connection string. URL-encode special characters in the username or password. |
| `MONGODB_DB_NAME` | The database name to use, for example `edgevault`. |
| `SESSION_SECRET` | A long, random secret used to sign session cookies. Generate a unique value for production. |
| `FRONTEND_ORIGINS` | Comma-separated exact origins allowed by CORS, including the scheme and no trailing slash, e.g. `https://your-site.netlify.app`. Add any custom domain origins too. |
| `NODE_ENV` | Set to `production`. |
| `COOKIE_SAME_SITE` | Set to `lax` for the same-origin Netlify deployment. Secure cookies are enabled automatically in production. |

`PORT` is only used by the local Express server and is not required on Netlify. `api-config.js` uses relative `/api/...` requests, so no deployed API URL needs to be configured in the frontend.

### MongoDB Atlas

Use an Atlas database user with only the permissions EdgeVault needs, and configure Atlas Network Access so the Netlify Functions runtime can reach the cluster. The app creates its journal/session collections and indexes as needed; you do not need to create a collection manually. Do not put database credentials or other secrets in frontend files or commit them to the repository.

## Checks

Run `npm run check` to check JavaScript syntax, including the Netlify function entry point.
