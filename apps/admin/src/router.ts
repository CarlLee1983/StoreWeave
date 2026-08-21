// 極簡 hash router：只解析 #/xxx 的第一段路徑，不做巢狀或參數比對。
// 有哪些路由由 routes.tsx 的路由表決定。
import { useEffect, useState } from 'react';
import { DEFAULT_ROUTE, isRoute, type Route } from './routes';

export type { Route };

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '');
  return isRoute(raw) ? raw : DEFAULT_ROUTE;
}

/** 目前的 hash 路由，並在 hash 變動時自動更新 */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parseHash());

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  return route;
}

export function navigate(route: Route): void {
  window.location.hash = `/${route}`;
}
