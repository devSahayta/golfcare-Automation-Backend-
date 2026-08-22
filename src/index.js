const app = require("./app");
const { env } = require("./config/env");

app.listen(env.port, () => {
  console.log(`Golf Care OS API listening on port ${env.port}`);
});
