

export default {
  async fetch(request, env, ctx) {
    return new Response("CICT Studio worker is alive", { status: 200 });
  },
};
