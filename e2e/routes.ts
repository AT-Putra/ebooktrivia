export const PUBLIC_URL = "http://127.0.0.1:3100";
export const ADMIN_URL = "http://127.0.0.1:3200";
/** Same builds, started without ENABLE_MOCKUPS, to prove the 404 guard. */
export const PUBLIC_GUARDED_URL = "http://127.0.0.1:3101";
export const ADMIN_GUARDED_URL = "http://127.0.0.1:3201";

export interface MockupRoute {
  /** File-name stem: docs/mockups/<slug>-<width>.png */
  slug: string;
  app: "public" | "admin";
  path: string;
  /** Admin routes: render in the light theme (the default is dark). */
  light?: boolean;
}

export const ROUTES: MockupRoute[] = [
  { slug: "trivia", app: "public", path: "/mockups/trivia" },
  { slug: "trivia-program-2", app: "public", path: "/mockups/trivia?program=sains" },
  { slug: "trivia-play", app: "public", path: "/mockups/trivia/play" },
  { slug: "trivia-play-correct", app: "public", path: "/mockups/trivia/play?state=correct" },
  { slug: "trivia-play-wrong", app: "public", path: "/mockups/trivia/play?state=wrong" },
  { slug: "trivia-play-timeout", app: "public", path: "/mockups/trivia/play?state=timeout" },
  { slug: "order-pending", app: "public", path: "/mockups/order/pending" },
  { slug: "order-paid", app: "public", path: "/mockups/order/paid" },
  { slug: "order-expired", app: "public", path: "/mockups/order/expired" },
  { slug: "order-failed", app: "public", path: "/mockups/order/failed" },
  { slug: "admin-dashboard", app: "admin", path: "/mockups/dashboard" },
  { slug: "admin-dashboard-light", app: "admin", path: "/mockups/dashboard", light: true },
];

export function urlFor(route: MockupRoute): string {
  return (route.app === "public" ? PUBLIC_URL : ADMIN_URL) + route.path;
}

export const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 1280, height: 800 },
] as const;
