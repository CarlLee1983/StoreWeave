import { adminProjection } from '@storeweave/selected-admin';
import type { AdminNavBadge, AdminRouteDefinition } from '@storeweave/release/admin';
import type { ReactNode } from 'react';
import type { MessageKey } from './i18n';
import type { IconName } from './components/Icon';

/** Selected build-time route data; this shell contains no product page imports. */
export const NAV_SECTIONS = adminProjection.navSections;
export const DEFAULT_ROUTE = adminProjection.defaultRoute;

export type Route = (typeof adminProjection.routes)[number]['path'];
export type NavSection = (typeof NAV_SECTIONS)[number];
export type NavBadge = AdminNavBadge;

export interface RouteContext {
  /** 死信數量，供標記使用 */
  deadJobCount: number;
  /** 初次讀取失敗時顯示可辨識的側欄錯誤，不把失敗偽裝成零。 */
  deadJobError: boolean;
}

export type RouteDefinition = AdminRouteDefinition<Route, MessageKey, IconName, NavSection, RouteContext, ReactNode>;

export const ROUTE_TABLE = adminProjection.routes as readonly RouteDefinition[];

/** 看得到什麼由這個人的權限與這個 release 實際載入的模組決定。 */
export interface RouteViewer {
  /** `GET /api/v1/auth/me` 回的權限清單；`*` 是 admin 的萬用權。 */
  readonly permissions: readonly string[];
  /** 這個 release 載入了哪些模組。沒有 rma 模組就不該有退貨頁。 */
  readonly modules: readonly string[];
}

export function routeDefinition(route: Route): RouteDefinition {
  const found = ROUTE_TABLE.find((entry) => entry.path === route);
  if (!found) throw new Error(`未知的路由：${route}`);
  return found;
}

export function isRoute(value: string): value is Route {
  return ROUTE_TABLE.some((entry) => entry.path === value);
}

/**
 * Sidebar visibility is presentation only. The API endpoint still authorizes every request.
 */
export function visibleRoutes(viewer: RouteViewer): readonly RouteDefinition[] {
  const permissions = new Set(viewer.permissions);
  const modules = new Set(viewer.modules);
  const holds = (key: string) => permissions.has('*') || permissions.has(key);
  return ROUTE_TABLE.filter((entry) =>
    entry.permissions.every(holds) && (entry.module === undefined || modules.has(entry.module)));
}

/** The router starts on the first visible route if its default is hidden. */
export function firstVisibleRoute(routes: readonly RouteDefinition[]): Route | null {
  if (routes.some((entry) => entry.path === DEFAULT_ROUTE)) return DEFAULT_ROUTE;
  return routes[0]?.path ?? null;
}
