// An app that fails on start, as a dev server with a broken config does.
console.log("starting up");
console.error("boom: DATABASE_URL is not set");
process.exit(1);
