import { Logger } from 'homebridge';
import { RegionMap } from '../platformUtils';
import GigyaApi from './GigyaApi';
import { BLUEAIR_API_TIMEOUT, BLUEAIR_CONFIG, BlueAirDeviceStatusResponse, LOGIN_EXPIRATION } from './Consts';
import { Mutex } from 'async-mutex';

type BlueAirDeviceDiscovery = {
  mac: string;
  'mcu-firmware': string;
  name: string;
  type: string;
  'user-type': string;
  uuid: string;
  'wifi-firmware': string;
};

export type FullBlueAirDeviceState = BlueAirDeviceState & BlueAirDeviceSensorData;

export type BlueAirDeviceState = {
  cfv?: string;
  germshield?: boolean;
  gsnm?: boolean;
  standby?: boolean;
  fanspeed?: number;
  childlock?: boolean;
  nightmode?: boolean;
  mfv?: string;
  automode?: boolean;
  ofv?: string;
  brightness?: number;
  safetyswitch?: boolean;
  filterusage?: number;
  disinfection?: boolean;
  disinftime?: number;
};

export type BlueAirDeviceSensorData = {
  fanspeed?: number;
  hcho?: number;
  humidity?: number;
  pm1?: number;
  pm10?: number;
  pm2_5?: number;
  temperature?: number;
  voc?: number;
};

export type BlueAirDeviceStatus = {
  id: string;
  name: string;
  state: BlueAirDeviceState;
  sensorData: BlueAirDeviceSensorData;
};

type BlueAirSetStateBody = {
  n: string;
  v?: number;
  vb?: boolean;
};

export const BlueAirDeviceSensorDataMap = {
  fsp0: 'fanspeed',
  hcho: 'hcho',
  h: 'humidity',
  pm1: 'pm1',
  pm10: 'pm10',
  pm2_5: 'pm2_5',
  t: 'temperature',
  tVOC: 'voc',
};

export default class BlueAirAwsApi {
  private readonly gigyaApi: GigyaApi;

  private last_login: number;

  private mutex: Mutex;

  private accessToken: string;
  private idToken: string;
  private blueAirApiUrl: string;

  constructor(
    username: string,
    password: string,
    region: string,
    private readonly logger: Logger,
  ) {
    const config = BLUEAIR_CONFIG[RegionMap[region]].awsConfig;
    this.blueAirApiUrl = `https://${config.restApiId}.execute-api.${config.awsRegion}.amazonaws.com/prod/c`;

    this.mutex = new Mutex();

    this.logger.debug(`Creating BlueAir API instance with config: ${JSON.stringify(config)} and username: ${username}\
    and region: ${region}`);

    this.gigyaApi = new GigyaApi(username, password, region, logger);

    this.last_login = 0;
    this.accessToken = '';
    this.idToken = '';
  }

  async login(): Promise<void> {
    this.logger.debug('Logging in...');

    const { token, secret } = await this.gigyaApi.getGigyaSession();
    const { jwt } = await this.gigyaApi.getGigyaJWT(token, secret);
    const { accessToken, idToken } = await this.getAwsAccessToken(jwt);

    this.last_login = Date.now();
    this.accessToken = accessToken;
    this.idToken = idToken;

    this.logger.debug('Logged in');
  }

  async checkTokenExpiration(): Promise<void> {
    if (LOGIN_EXPIRATION < Date.now() - this.last_login) {
      this.logger.debug('Token expired, logging in again');
      return await this.login();
    }
    return;
  }

  async getDevices(): Promise<BlueAirDeviceDiscovery[]> {
    await this.checkTokenExpiration();

    this.logger.debug('Getting devices...');

    const response = await this.apiCall('/registered-devices', undefined, 'GET');

    if (!response.devices) {
      throw new Error('getDevices error: no devices in response');
    }

    const devices = response.devices as BlueAirDeviceDiscovery[];
    return devices;
  }

  async getDeviceStatus(accountUuid: string, uuids: string[]): Promise<BlueAirDeviceStatus[]> {
    await this.checkTokenExpiration();

    const body = {
      deviceconfigquery: uuids.map((uuid) => ({ id: uuid, r: { r: ['sensors'] } })),
      includestates: true,
      eventsubscription: {
        include: uuids.map((uuid) => ({ filter: { o: `= ${uuid}` } })),
      },
    };
    const data = await this.apiCall<BlueAirDeviceStatusResponse>(`/${accountUuid}/r/initial`, body);

    if (!data.deviceInfo) {
      throw new Error('getDeviceStatus error: no deviceInfo in response');
    }

    const deviceStatuses: BlueAirDeviceStatus[] = data.deviceInfo.map((device) => {
      return {
        id: device.id,
        name: device.configuration.di.name,
        sensorData: device.sensordata.reduce((acc, sensor) => {
          const key = BlueAirDeviceSensorDataMap[sensor.n];
          if (key) {
            acc[key] = sensor.v;
          }
          return acc;
        }, {} as BlueAirDeviceSensorData),
        state: device.states.reduce((acc, state) => {
          if (state.v !== undefined) {
            acc[state.n] = state.v;
          } else if (state.vb !== undefined) {
            acc[state.n] = state.vb;
          } else {
            this.logger.warn(`getDeviceStatus: unknown state ${JSON.stringify(state)}`);
          }
          return acc;
        }, {} as BlueAirDeviceState),
      };
    });

    return deviceStatuses;
  }

  async setDeviceStatus(uuid: string, state: keyof BlueAirDeviceState, value: number | boolean): Promise<void> {
    await this.checkTokenExpiration();

    // this.logger.debug(`setDeviceStatus: ${uuid} ${state} ${value}`);

    const body: BlueAirSetStateBody = {
      n: state,
    };

    if (typeof value === 'number') {
      body.v = value;
    } else if (typeof value === 'boolean') {
      body.vb = value;
    } else {
      throw new Error(`setDeviceStatus: unknown value type ${typeof value}`);
    }

    // const response = await this.apiCall(`/${uuid}/a/${state}`, body);
    await this.apiCall(`/${uuid}/a/${state}`, body);
    // this.logger.debug(`setDeviceStatus response: ${JSON.stringify(response)}`);
  }

  private async getAwsAccessToken(jwt: string): Promise<{ accessToken: string; idToken: string }> {
    this.logger.debug('Getting AWS access token...');

    const response = await this.apiCall('/login', undefined, 'POST', {
      Authorization: `Bearer ${jwt}`,
      idtoken: jwt,
    });

    if (!response.access_token) {
      throw new Error(`AWS access token error: ${JSON.stringify(response)}`);
    }

    this.logger.debug('AWS access token received');
    return {
      accessToken: response.access_token,
      idToken: response.id_token ?? jwt,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async apiCall<T = any>(
    url: string,
    data?: string | object,
    method = 'POST',
    headers: Record<string, string> = {},
    retries = 3,
  ): Promise<T> {
    const release = await this.mutex.acquire();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BLUEAIR_API_TIMEOUT);
    try {
      const defaultHeaders: Record<string, string> = {
        Accept: '*/*',
        Connection: 'keep-alive',
        'Accept-Encoding': 'gzip, deflate, br',
        Authorization: `Bearer ${this.accessToken}`,
        idtoken: this.idToken || this.accessToken,
        ...headers,
      };

      let body: string | undefined;
      if (data !== undefined) {
        if (typeof data === 'string') {
          body = data;
        } else {
          body = JSON.stringify(data);
          if (!('Content-Type' in defaultHeaders) && !('content-type' in defaultHeaders)) {
            defaultHeaders['Content-Type'] = 'application/json';
          }
        }
      }

      const response = await fetch(`${this.blueAirApiUrl}${url}`, {
        method: method,
        headers: defaultHeaders,
        body,
        signal: controller.signal,
      });

      const responseText = response.status === 204 ? '' : await response.text();

      if (response.status < 200 || response.status >= 300) {
        throw new Error(`API call error with status ${response.status}: ${response.statusText}, ${responseText || 'No body returned.'}`);
      }

      if (!responseText) {
        return undefined as T;
      }

      try {
        return JSON.parse(responseText) as T;
      } catch (error) {
        this.logger.debug(`Failed to parse response as JSON for ${url}, returning raw text. Error: ${error}`);
        return responseText as unknown as T;
      }
    } catch (error) {
      if (retries > 0) {
        return this.apiCall(url, data, method, headers, retries - 1);
      } else {
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error(`API call failed after ${3 - retries} retries with timeout.`);
        } else {
          throw new Error(`API call failed after ${3 - retries} retries with error: ${error}`);
        }
      }
    } finally {
      clearTimeout(timeout);
      release();
    }
  }
}
