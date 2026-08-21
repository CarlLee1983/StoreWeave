// 極簡 hash router：只解析 #/xxx 的第一段路徑，不做巢狀或參數比對。
import { useEffect, useState } from 'react';

export type Route = 'products' | 'orders' | 'erp' | 'system' | 'dlq';

const ROUTES: Route[] = ['products', 'orders', 'erp', 'system', 'dlq'];
const DEFAULT_ROUTE: Route = 'products';

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#\/?/, '');
  return (ROUTES as string[]).includes(raw) ? (raw as Route) : DEFAULT_ROUTE;
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
