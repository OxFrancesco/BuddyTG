import index from "./index.html"
import og from "./og.html"

const server = Bun.serve({
  port: Number(process.env.PORT ?? 4820),
  hostname: "127.0.0.1",
  routes: { "/": index, "/og": og },
  development: { hmr: true, console: true },
})

console.log(`BuddyTG site on ${server.url}`)
