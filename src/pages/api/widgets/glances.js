import { getPrivateWidgetOptions } from "utils/config/widget-helpers";
import createLogger from "utils/logger";
import { httpProxy } from "utils/proxy/http";

const logger = createLogger("glances");

async function retrieveFromGlancesAPI(privateWidgetOptions, endpoint) {
  let errorMessage;
  const url = privateWidgetOptions?.url;
  if (!url) {
    errorMessage = "Missing Glances URL";
    logger.error(errorMessage);
    throw new Error(errorMessage);
  }

  const apiUrl = `${url}/api/${privateWidgetOptions.version}/${endpoint}`;
  const headers = {
    "Accept-Encoding": "application/json",
  };
  if (privateWidgetOptions.username && privateWidgetOptions.password) {
    headers.Authorization = `Basic ${Buffer.from(
      `${privateWidgetOptions.username}:${privateWidgetOptions.password}`,
    ).toString("base64")}`;
  }
  const params = { method: "GET", headers };

  const [status, , data] = await httpProxy(apiUrl, params);

  if (status === 401) {
    errorMessage = `Authorization failure getting data from glances API. Data: ${data.toString()}`;
    logger.error(errorMessage);
    throw new Error(errorMessage);
  }

  if (status !== 200) {
    errorMessage = `HTTP ${status} getting data from glances API. Data: ${data.toString()}`;
    logger.error(errorMessage);
    throw new Error(errorMessage);
  }

  return JSON.parse(Buffer.from(data).toString());
}

export default async function handler(req, res) {
  const { index, cputemp: includeCpuTemp, uptime: includeUptime, disk: includeDisks, gpu: includeGpu, version } = req.query;

  const privateWidgetOptions = await getPrivateWidgetOptions("glances", index);
  privateWidgetOptions.version = version ?? 3;

  try {
    const cpuData = await retrieveFromGlancesAPI(privateWidgetOptions, "cpu");
    const loadData = await retrieveFromGlancesAPI(privateWidgetOptions, "load");
    const memoryData = await retrieveFromGlancesAPI(privateWidgetOptions, "mem");
    const data = {
      cpu: cpuData,
      load: loadData,
      mem: memoryData,
    };

    // Disabled by default, dont call unless needed
    if (includeUptime) {
      data.uptime = await retrieveFromGlancesAPI(privateWidgetOptions, "uptime");
    }

    if (includeCpuTemp) {
      data.sensors = await retrieveFromGlancesAPI(privateWidgetOptions, "sensors");
    }

    if (includeDisks) {
      data.fs = await retrieveFromGlancesAPI(privateWidgetOptions, "fs");
    }

    if (includeGpu) {
      data.gpu = await retrieveFromGlancesAPI(privateWidgetOptions, "gpu");
      // Enrich GPU data with absolute VRAM from nvidia-smi
      try {
        const { execSync } = require("child_process");
        const nvOut = execSync(
          "nvidia-smi --query-gpu=index,memory.used,memory.total --format=csv,noheader,nounits",
          { timeout: 3000 },
        ).toString().trim();
        const nvGpus = nvOut.split("\n").map((line) => {
          const [idx, used, total] = line.split(",").map((s) => s.trim());
          return { index: parseInt(idx, 10), memUsed: parseInt(used, 10) * 1024 * 1024, memTotal: parseInt(total, 10) * 1024 * 1024 };
        });
        data.gpu = data.gpu.map((g, i) => {
          const nv = nvGpus[i];
          return nv ? { ...g, memUsed: nv.memUsed, memTotal: nv.memTotal } : g;
        });
      } catch (e) {
        // nvidia-smi not available, keep percentage-only data
      }
    }

    return res.status(200).send(data);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
}
