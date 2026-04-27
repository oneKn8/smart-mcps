import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";

export function makeServer() {
  return setupServer();
}

export { http, HttpResponse };
