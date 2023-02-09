import fs from "fs";
import path from "path";
import util from "util";
import { Context, Next } from "koa";
import { escape } from "lodash";
import { Sequelize } from "sequelize";
import isUUID from "validator/lib/isUUID";
import { IntegrationType } from "@shared/types";
import documentLoader from "@server/commands/documentLoader";
import env from "@server/env";
import { Integration } from "@server/models";
import presentEnv from "@server/presenters/env";
import { getTeamFromContext } from "@server/utils/passport";
import prefetchTags from "@server/utils/prefetchTags";
import readManifestFile from "@server/utils/readManifestFile";

const isProduction = env.ENVIRONMENT === "production";
const isDevelopment = env.ENVIRONMENT === "development";
const isTest = env.ENVIRONMENT === "test";
const readFile = util.promisify(fs.readFile);
let indexHtmlCache: Buffer | undefined;

const readIndexFile = async (): Promise<Buffer> => {
  if (isProduction || isTest) {
    if (indexHtmlCache) {
      return indexHtmlCache;
    }
  }

  if (isDevelopment) {
    return await readFile(
      path.join(__dirname, "../../../server/static/index.html")
    );
  }

  return (indexHtmlCache = await readFile(
    path.join(__dirname, "../../app/index.html")
  ));
};

export const renderApp = async (
  ctx: Context,
  next: Next,
  options: {
    title?: string;
    description?: string;
    canonical?: string;
    analytics?: Integration | null;
  } = {}
) => {
  const {
    title = env.APP_NAME,
    description = "A modern team knowledge base for your internal documentation, product specs, support answers, meeting notes, onboarding, &amp; more…",
    canonical = "",
  } = options;

  if (ctx.request.path === "/realtime/") {
    return next();
  }

  const { shareId } = ctx.params;
  const page = await readIndexFile();
  const environment = `
    window.env = ${JSON.stringify(presentEnv(env, options.analytics))};
  `;
  const serviceWorker = `<script src="/registerSW.js"></script>`;
  const entry = "app/index.tsx";
  const scriptTags = isProduction
    ? `<script type="module" src="${process.env.CDN_URL}/${
        readManifestFile()[entry]["file"]
      }"></script>`
    : `<script type="module">
        import RefreshRuntime from 'http://localhost:3001/@react-refresh'
        RefreshRuntime.injectIntoGlobalHook(window)
        window.$RefreshReg$ = () => { }
        window.$RefreshSig$ = () => (type) => type
        window.__vite_plugin_react_preamble_installed__ = true
      </script>
      <script type="module" src="http://localhost:3001/@vite/client"></script>
      <script type="module" src="http://localhost:3001/${entry}"></script>
    `;

  ctx.body = page
    .toString()
    .replace(/\/\/inject-env\/\//g, environment)
    .replace(/\/\/inject-title\/\//g, escape(title))
    .replace(/\/\/inject-description\/\//g, escape(description))
    .replace(/\/\/inject-canonical\/\//g, canonical)
    .replace(/\/\/inject-prefetch\/\//g, shareId ? "" : prefetchTags)
    .replace(/\/\/inject-service-worker\/\//g, serviceWorker)
    .replace(/\/\/inject-slack-app-id\/\//g, env.SLACK_APP_ID || "")
    .replace(/\/\/inject-script-tags\/\//g, scriptTags);
};

export const renderShare = async (ctx: Context, next: Next) => {
  const { shareId, documentSlug } = ctx.params;
  // Find the share record if publicly published so that the document title
  // can be be returned in the server-rendered HTML. This allows it to appear in
  // unfurls with more reliablity
  let share, document, analytics;

  try {
    const team = await getTeamFromContext(ctx);
    const result = await documentLoader({
      id: documentSlug,
      shareId,
      teamId: team?.id,
    });
    share = result.share;
    if (isUUID(shareId) && share?.urlId) {
      // Redirect temporarily because the url slug
      // can be modified by the user at any time
      ctx.redirect(share.canonicalUrl);
      ctx.status = 307;
      return;
    }
    document = result.document;

    analytics = await Integration.findOne({
      where: {
        teamId: document.teamId,
        type: IntegrationType.Analytics,
      },
    });

    if (share && !ctx.userAgent.isBot) {
      await share.update({
        lastAccessedAt: new Date(),
        views: Sequelize.literal("views + 1"),
      });
    }
  } catch (err) {
    // If the share or document does not exist, return a 404.
    ctx.status = 404;
  }

  // Allow shares to be embedded in iframes on other websites
  ctx.remove("X-Frame-Options");

  // Inject share information in SSR HTML
  return renderApp(ctx, next, {
    title: document?.title,
    description: document?.getSummary(),
    analytics,
    canonical: share
      ? `${share.canonicalUrl}${documentSlug && document ? document.url : ""}`
      : undefined,
  });
};
