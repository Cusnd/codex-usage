declare namespace Cloudflare {
  interface Env {
    GITHUB_CLIENT_SECRET: string;
  }
}
interface Env extends Cloudflare.Env {}
