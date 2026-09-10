# jiborobot/srv-security-gw:src/controllers/auth.ctrl.ts

import { Boom, log } from "@jibo/server";
import IAccountClient from "../clients/account.client";
import * as Errors from "../errors/account";
import * as util from "../util";
import * as V4 from "../v4";

const unauthorizedMethods = [
  "Backup_20150617.CreateBackupAnon",
  "Backup_20150617.RemoveBackupAnon",
  "Backup_20150617.ListBackupsAnon",
  "Backup_20150617.GetBackupAnon",
  "Account_20151111.CheckEmail",
  "Account_20151111.Create",
  "Account_20151111.Login",
  "Account_20151111.ResendActivationCode",
  "Account_20151111.ActivateByCode",
  "Account_20151111.ConfirmEmailReset",
  "Account_20151111.SendPasswordReset",
  "Account_20151111.PasswordResetByCode",
  "Account_20151111.GetAccountByAccessToken",
  "Loop_20160324.AcceptInvitationByCode",
  "Loop_20160324.DeclineInvitationByCode",
  "Loop_20160324.UpdateAgreementStatus",
  "Crew_20160324.AcceptInvitationByCode",
  "Crew_20160324.DeclineInvitationByCode",
  "OOBE_20161026.GetStatus",
  "OOBE_20161026.SetupRobot",
];
const unsignedMethods = [
];
const unactiveMethods = [
  "Account_20151111.Remove",
];

export class AuthController {
  private accountClient: IAccountClient;

  constructor(accountClient: IAccountClient) {
    this.accountClient = accountClient;
  }

  public async getCredentials(request) {
    const target = request.headers["x-amz-target"];
    await this.parsePayload(request);
    if (unauthorizedMethods.indexOf(target) !== -1 && !request.headers.authorization) {
      return {};
    }
    if (!request.headers.authorization) {
      throw Boom.createWithCode(Errors.MISSING_AUTH_HEADER);
    }
    if (!request.headers.authorization.startsWith("AWS4") && unsignedMethods.indexOf(target) !== -1) {
      const accessKeyId = request.headers.authorization;
      const credentials = await this.getAccountByAccessKey(accessKeyId, target);
      return credentials;
    }
    const req = await this.parse(request);
    return await this.verify(req);
  }

  public async getAccountByAccessKey(accessKeyId, target) {
    let data;
    try {
      data = await this.accountClient.findByAccessKeyId(accessKeyId);
    } catch (err) {
      if (err.isServer) {
        log.error("Account service returned unexpected error: ", JSON.stringify(err, null, 2));
        throw err;
      }
      // rethrow Boom errors with initial error codes, just change statusCode
      if (err.isBoom && err.output) {
        err.output.statusCode = 401;
        throw err;
      }
      // for whatever 3xx/4xx reason error happened are unauthorized to process
      throw  Boom.unauthorized(err.message);
    }
    if (data && !data.isActive && unactiveMethods.indexOf(target) === -1) {
      throw Boom.createWithCode(Errors.ACCOUNT_NOT_ACTIVE);
    }
    if (data) {
      return data;
    }
    throw Boom.createWithCode(Errors.ACCESS_KEY_NOT_FOUND);
  }

  private parseAmazonDate(dateStr) {
    dateStr = dateStr && dateStr.replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, "$1-$2-$3T$4:$5:$6Z");
    return new Date(dateStr);
  }
  private copySigned(req) {
    const signedHeaders = {};
    for (const key in req.headers) {
      if (req.signedHeaders.indexOf(key) !== -1) {
        signedHeaders[key] = req.headers[key];
      }
    }
    req.headers = signedHeaders;
  }
  private async readStream(stream) {
    return new Promise((resolve) => {
      let body = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        body += chunk;
      });
      stream.on("end", () => {
        resolve(body);
      });
    });
  }
  private async parsePayload(request) {
    const contentType = request.headers["content-type"];
    const isJson = contentType && (contentType === "application/x-amz-json-1.1" ||
      contentType.startsWith("application/json"));
    if (isJson && !request.headers["x-amz-content-sha256"]) {
      request.payload = await this.readStream(request.payload);
    }
  }
  private async parse(request) {
    const authorization = request.headers.authorization;
    const requestDateTime = request.headers["x-amz-date"] || request.headers.date;
    if (!requestDateTime) {
      throw Boom.createWithCode(Errors.MISSING_DATE_HEADER);
    }
    const parsedDate = this.parseAmazonDate(requestDateTime);
    if (Math.abs(parsedDate.getTime() - new Date().getTime()) > 15 * 60 * 1000) {
      throw Boom.createWithCode(Errors.CLOCK_SKEW_TOO_LONG);
    }
    if (!authorization) {
      throw Boom.createWithCode(Errors.MISSING_AUTH_HEADER);
    }
    const split = authorization.split(", ");
    const algAndCredentials = split[0].split(" ");
    if (algAndCredentials[0] !== "AWS4-HMAC-SHA256") {
      throw Boom.createWithCode(Errors.MISSING_ENCRYPTION_ALGORITHM);
    }
    const credential = algAndCredentials[1].split("=")[1];
    const credentials = credential.split("/");
    const isMultipart = request.headers["content-type"] &&
      request.headers["content-type"].indexOf("multipart/form-data") === 0;
    const req = {
      body: request.payload.toString(),
      credential: {
        credentialScope: credentials[4],
        date: credentials[1],
        region: credentials[2],
        service: credentials[3],
        user: credentials[0],
      },
      headers: request.headers,
      isMultipart,
      method: request.method.toUpperCase(),
      path: request.path,
      region: credentials[2],
      search: () => {
        let query = request.path.split("?", 2)[1];
        if (query) {
          query = util.queryStringParse(query);
          return util.queryParamsToString(query);
        }
        return "";
      },
      signature: split[2].split("=")[1],
      signedHeaders: split[1].split("=")[1],

    };
    return req;
  }

  private async verify(req) {
    const accessKeyId = req.credential.user;
    const credentials = await this.getAccountByAccessKey(accessKeyId, req.headers["x-amz-target"]);
    const authorization = req.headers.authorization;
    const requestDateTime = req.headers["x-amz-date"] || req.headers.date;
    // this.copySigned(req); Seems like we"re ok with all headers being there
    const v4 = new V4(req, req.credential.service);
    const expected = v4.authorization({
      accessKeyId,
      secretAccessKey: credentials && credentials.secretAccessKey,
    }, requestDateTime);
    if (expected !== authorization) {
      log.info("Last Canonical String: " + v4.lastCanonicalString);
      throw Boom.createWithCode(Errors.SIGNATURE_MISMATCH);
    }
    return credentials;
  }
}
