export const logger = {
  info: (dataOrMsg: any, msg?: string) => {
    if (typeof dataOrMsg === "string") {
      console.log(`[INFO] ${dataOrMsg}`);
    } else {
      console.log(`[INFO] ${msg ?? ""} ${JSON.stringify(dataOrMsg)}`);
    }
  },
  debug: (dataOrMsg: any, msg?: string) => {
    if (process.env.DEBUG) {
      if (typeof dataOrMsg === "string") {
        console.debug(`[DEBUG] ${dataOrMsg}`);
      } else {
        console.debug(`[DEBUG] ${msg ?? ""} ${JSON.stringify(dataOrMsg)}`);
      }
    }
  },
  warn: (dataOrMsg: any, msg?: string) => {
    if (typeof dataOrMsg === "string") {
      console.warn(`[WARN] ${dataOrMsg}`);
    } else {
      console.warn(`[WARN] ${msg ?? ""} ${JSON.stringify(dataOrMsg)}`);
    }
  },
  error: (dataOrMsg: any, msg?: string) => {
    if (typeof dataOrMsg === "string") {
      console.error(`[ERROR] ${dataOrMsg}`);
    } else {
      console.error(`[ERROR] ${msg ?? ""} ${JSON.stringify(dataOrMsg)}`);
    }
  },
};
