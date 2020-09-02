/* Copyright(C) 2017-2020, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * protect-nvr.ts: NVR device class for UniFi Protect.
 */
import {
  API,
  APIEvent,
  HAP,
  Logging,
  PlatformAccessory
} from "homebridge";
import { ProtectApi } from "./protect-api";
import { ProtectCamera, PROTECT_SWITCH_TRIGGER } from "./protect-camera";
import { ProtectDoorbell } from "./protect-doorbell";
import { ProtectLiveviews } from "./protect-liveviews";
import { ProtectMqtt } from "./protect-mqtt";
import { ProtectPlatform } from "./protect-platform";
import {
  ProtectCameraConfig,
  ProtectNvrBootstrap,
  ProtectNvrOptions,
  ProtectNvrSystemEvent,
  ProtectNvrSystemEventController
} from "./protect-types";
import {
  PLATFORM_NAME,
  PLUGIN_NAME,
  PROTECT_NVR_DOORBELL_REFRESH_INTERVAL,
  PROTECT_NVR_UCK_REFRESH_INTERVAL,
  PROTECT_NVR_UNIFIOS_REFRESH_INTERVAL
} from "./settings";

export class ProtectNvr {
  private api: API;
  public config: ProtectNvrOptions;
  private readonly configuredCameras: { [index: string]: ProtectCamera | ProtectDoorbell };
  private debug: (message: string, ...parameters: unknown[]) => void;
  public doorbellCount: number;
  private isEnabled: boolean;
  private hap: HAP;
  private lastMotion: { [index: string]: number };
  private lastRing: { [index: string]: number };
  private liveviews: ProtectLiveviews | null;
  private log: Logging;
  private motionDuration: number;
  public mqtt: ProtectMqtt | null;
  private readonly eventTimers: { [index: string]: NodeJS.Timeout };
  private name: string;
  private nvrAddress: string;
  public nvrApi!: ProtectApi;
  public platform: ProtectPlatform;
  private pollingTimer!: NodeJS.Timeout;
  private refreshInterval: number;
  private unsupportedDevices: { [index: string]: boolean };

  constructor(platform: ProtectPlatform, nvrOptions: ProtectNvrOptions) {
    this.api = platform.api;
    this.config = nvrOptions;
    this.configuredCameras = {};
    this.debug = platform.debug.bind(platform);
    this.doorbellCount = 0;
    this.isEnabled = false;
    this.hap = this.api.hap;
    this.lastMotion = {};
    this.lastRing = {};
    this.liveviews = null;
    this.log = platform.log;
    this.mqtt = null;
    this.name = nvrOptions.name;
    this.motionDuration = platform.config.motionDuration;
    this.eventTimers = {};
    this.nvrAddress = nvrOptions.address;
    this.platform = platform;
    this.refreshInterval = nvrOptions.refreshInterval;
    this.unsupportedDevices = {};

    // Assign a name, if we don't have one.
    if(!this.name) {
      this.name = this.nvrAddress;
    }

    // Validate our Protect address and login information.
    if(!nvrOptions.address || !nvrOptions.username || !nvrOptions.password) {
      return;
    }

    // Initialize our connection to the UniFi Protect API.
    this.nvrApi = new ProtectApi(platform, nvrOptions.address, nvrOptions.username, nvrOptions.password);

    // Initialize our liveviews.
    this.liveviews = new ProtectLiveviews(this);

    // Cleanup any stray ffmpeg sessions on shutdown.
    this.api.on(APIEvent.SHUTDOWN, () => {
      for(const protectCamera of Object.values(this.configuredCameras)) {
        this.debug("%s: Shutting down all video stream processes.", protectCamera.name());
        protectCamera.stream?.shutdown();
      }
    });
  }

  // Discover new UniFi Protect devices.
  private discoverAndSyncAccessories(): boolean {

    // Iterate through the list of cameras that Protect has returned and sync them with what we show HomeKit.
    for(const camera of this.nvrApi.Cameras ?? []) {

      // If we have no MAC address, name, or this camera isn't being managed by Protect, we skip.
      if(!camera.mac || !camera.name || !camera.isManaged) {
        continue;
      }

      // We are only interested in cameras. Perhaps more types in the future.
      if(camera.modelKey !== "camera") {

        // If we've already informed the user about this one, we're done.
        if(this.unsupportedDevices[camera.mac]) {
          continue;
        }

        // Notify the user we see this camera, but we aren't adding it to HomeKit.
        this.unsupportedDevices[camera.mac] = true;

        this.log("%s: UniFi Protect camera type '%s' is not currently supported, ignoring: %s.",
          this.nvrApi.getNvrName(), camera.modelKey, this.nvrApi.getDeviceName(camera));

        continue;
      }

      // Exclude or include certain devices based on configuration parameters.
      if(!this.optionEnabled(camera)) {
        continue;
      }

      // Generate this camera's unique identifier.
      const uuid = this.hap.uuid.generate(camera.mac);

      let accessory: PlatformAccessory | undefined;

      // See if we already know about this accessory or if it's truly new. If it is new, add it to HomeKit.
      if((accessory = this.platform.accessories.find((x: PlatformAccessory) => x.UUID === uuid)) === undefined) {
        accessory = new this.api.platformAccessory(camera.name, uuid);

        this.log("%s: Adding %s to HomeKit.", this.nvrApi.getFullName(camera), camera.modelKey);

        // Register this accessory with homebridge and add it to the accessory array so we can track it.
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.platform.accessories.push(accessory);
      }

      // Link the accessory to it's camera object and it's hosting NVR.
      accessory.context.camera = camera;
      accessory.context.nvr = this.nvrApi.bootstrap?.nvr.mac;

      // Setup the Protect camera if it hasn't been configured yet.
      if(!this.configuredCameras[accessory.UUID]) {

        // Eventually switch on multiple types of UniFi Protect cameras. For now, it's cameras only...
        if(camera.type === "UVC G4 Doorbell") {
          this.configuredCameras[accessory.UUID] = new ProtectDoorbell(this, accessory);
        } else {
          this.configuredCameras[accessory.UUID] = new ProtectCamera(this, accessory);
        }

      } else {

        // Finally, check if we have changes to the exposed RTSP streams on our cameras.
        void this.configuredCameras[accessory.UUID].configureVideoStream();

        // Check for changes to the doorbell LCD as well.
        if(camera.type === "UVC G4 Doorbell") {
          void (this.configuredCameras[accessory.UUID] as ProtectDoorbell).configureDoorbellLcdSwitch();
        }

      }
    }

    // Remove Protect cameras that are no longer found on this Protect NVR, but we still have in HomeKit.
    this.cleanupDevices();

    // Configure our liveview-based accessories.
    this.liveviews?.configureLiveviews();

    return true;
  }

  // Update HomeKit with the latest status from Protect.
  private async updateAccessories(): Promise<boolean> {

    // Refresh the full device list from the Protect API.
    if(!(await this.nvrApi.refreshDevices())) {
      return false;
    }

    // This NVR has been disabled. Stop polling for updates and let the user know that we're done here.
    // Only run this check once, since we don't need to repeat it again.
    if(!this.isEnabled && (this.platform.configOptions.indexOf("DISABLE." + (this.nvrApi.bootstrap as ProtectNvrBootstrap)?.nvr.mac.toUpperCase()) !== -1)) {
      this.log("%s: Disabling this Protect controller.", this.nvrApi.getNvrName());
      this.nvrApi.clearLoginCredentials();
      return false;
    }

    // Set a name for this NVR, if we haven't configured one for ourselves.
    if(!this.name && this.nvrApi?.bootstrap?.nvr) {
      this.name = this.nvrApi.bootstrap.nvr.name;
    }

    // If not already configured by the user, set the refresh interval here depending on whether we
    // have UniFi OS devices or not, since non-UniFi OS devices don't have a realtime API. We also
    // check to see whether doorbell devices have been removed and restore the prior refresh interval, if needed.
    let refreshUpdated = false;

    if(!this.refreshInterval || (!this.doorbellCount && (this.refreshInterval !== this.config.refreshInterval))) {

      if(!this.refreshInterval) {
        this.refreshInterval = this.config.refreshInterval = this.nvrApi.isUnifiOs ? PROTECT_NVR_UNIFIOS_REFRESH_INTERVAL : PROTECT_NVR_UCK_REFRESH_INTERVAL;
      } else {
        this.refreshInterval = this.config.refreshInterval;
      }

      // In case someone puts in an overly aggressive default value.
      if(this.refreshInterval < 2) {
        this.refreshInterval = this.config.refreshInterval = 2;
      }

      refreshUpdated = true;
    }

    // If we have doorbells, we need to poll more frequently.
    if(this.doorbellCount && this.refreshInterval !== PROTECT_NVR_DOORBELL_REFRESH_INTERVAL) {
      this.refreshInterval = PROTECT_NVR_DOORBELL_REFRESH_INTERVAL;
      this.log("%s: A doorbell has been detected. Setting the controller refresh interval to %s seconds.", this.nvrApi.getNvrName(), this.refreshInterval);
    } else if(refreshUpdated || !this.isEnabled) {

      // On startup or refresh interval change, we want to notify the user.
      this.log("%s: Controller refresh interval set to %s seconds.", this.nvrApi.getNvrName(), this.refreshInterval);
    }

    this.isEnabled = true;

    // Create an MQTT connection, if needed.
    if(!this.mqtt && this.config.mqttUrl) {
      this.mqtt = new ProtectMqtt(this);
    }

    // Check for doorbell events (all OSs) and motion events for non-UniFi OS controllers.
    this.checkProtectEvents();

    // Configure our event listener, if needed.
    this.configureEventListener();

    // Sync status and check for any new or removed accessories.
    this.discoverAndSyncAccessories();

    // Refresh the accessory cache.
    this.api.updatePlatformAccessories(this.platform.accessories);

    return true;
  }

  // Check for doorbell events (all OSs) and motion events for non-UniFi OS controllers.
  private checkProtectEvents(): boolean {
    // Ensure we're up and running.
    if(!this.nvrApi?.Cameras) {
      return false;
    }

    // For UniFi OS devices, we only check doorbell events here. Motion events are dealt with in the realtime API.
    if(this.nvrApi?.isUnifiOs && !this.doorbellCount) {
      return false;
    }

    // Iterate through the list of cameras, looking for the isMotionDetected event on each camera
    // in order to determine where there is motion.
    for(const camera of this.nvrApi.Cameras) {
      // We only want cameras that are managed.
      if(!camera.isManaged) {
        continue;
      }

      // If we don't have a doorbell configured, this is always false. If we do, only process ring events within 2 * refreshInterval.
      const isRingDetected = this.doorbellCount ? (this.refreshInterval * 2 * 1000) > (Date.now() - (camera.lastRing * 1000)) : false;

      // If we have no recent motion events and ring events to process, we're done.
      if(!camera.isMotionDetected && !isRingDetected) {
        continue;
      }

      // Find the accessory associated with this camera.
      const uuid = this.hap.uuid.generate(camera.mac);
      const accessory = this.platform.accessories.find((x: PlatformAccessory) => x.UUID === uuid);

      // If we don't have an accessory, it's probably because we've chosen to hide it. In that case,
      // just ignore and move on.
      if(!accessory) {
        continue;
      }

      // We process UniFi OS motion events elsewhere through the realtime API. UCK, we process here.
      if(!this.nvrApi.isUnifiOs) {
        void this.motionEventHandler(accessory, camera.lastMotion);
      }

      // No realtime API yet for doorbells, so we resort to polling.
      void this.doorbellEventHandler(accessory, camera.lastRing);
    }

    return true;
  }

  // Configure the realtime API event listener to trigger events on accessories, like motion.
  private configureEventListener(): boolean {

    // The event listener API only works on UniFi OS devices.
    if(!this.nvrApi.isUnifiOs) {
      return false;
    }

    // Only configure the event listener if it exists and it's not already configured.
    if(!this.nvrApi.eventListener || this.nvrApi.eventListenerConfigured) {
      return true;
    }

    // Listen for any messages coming in from our listener.
    this.nvrApi.eventListener.on("message", (event) => {

      const nvrEvent = JSON.parse(event as string) as ProtectNvrSystemEvent;

      // We're interested in device state change events.
      if(nvrEvent?.type !== "DEVICE_STATE_CHANGED") {
        return;
      }

      // We only want Protect controllers.
      const controller = nvrEvent.apps?.controllers?.find((x: ProtectNvrSystemEventController) => x.name === "protect");

      if(!controller) {
        return;
      }

      // Find the camera in our list of accessories so we can fire off the motion event.
      const foundCamera = Object.keys(this.configuredCameras).find((x: string) =>
        (this.configuredCameras[x].accessory.context.camera as ProtectCameraConfig).host === controller.info.lastMotionCameraAddress);

      // Nothing here - we may have disabled this camera or it's associated NVR.
      if(!foundCamera) {
        return;
      }

      // Now grab the accessory associated with the Protect device.
      const accessory = this.configuredCameras[foundCamera].accessory;

      // If we don't have an accessory, it's probably because we've chosen to hide it. In that case,
      // just ignore and move on. Alternatively, it could be a new camera that we just don't know about yet,
      // In either case, we keep ignore it.
      if(!accessory) {
        return;
      }

      // The UniFi OS realtime API returns lastMotion in seconds rather than milliseconds.
      this.motionEventHandler(accessory, controller.info.lastMotion * 1000);
    });

    // Mark the listener as configured.
    this.nvrApi.eventListenerConfigured = true;
    return true;
  }

  // Motion event processing from UniFi Protect and delivered to HomeKit.
  public motionEventHandler(accessory: PlatformAccessory, lastMotion: number): void {
    const camera = accessory.context.camera as ProtectCameraConfig;
    const hap = this.hap;

    if(!accessory || !camera || !lastMotion) {
      return;
    }

    // Have we seen this event before? If so...move along.
    if(this.lastMotion[camera.mac] >= lastMotion) {
      this.debug("%s: Skipping duplicate motion event.", this.nvrApi.getFullName(camera));
      return;
    }

    // We only consider events that have happened within the last two refresh intervals. Otherwise, we assume
    // it's stale data and don't inform the user.
    if((Date.now() - lastMotion) > (this.refreshInterval * 2 * 1000)) {
      this.debug("%s: Skipping motion event due to stale data.", this.nvrApi.getFullName(camera));
      return;
    }

    // Remember this event.
    this.lastMotion[camera.mac] = lastMotion;

    // If we already have a motion event inflight, allow it to complete so we don't spam users.
    if(this.eventTimers[camera.mac]) {
      return;
    }

    // Only notify the user if we have a motion sensor and it's active.
    const motionService = accessory.getService(hap.Service.MotionSensor);

    if(!motionService) {
      return;
    }

    // If we have disabled motion events, we're done here.
    if(("detectMotion" in accessory.context) && !accessory.context.detectMotion) {
      return;
    }

    // Trigger the motion event in HomeKit.
    motionService.getCharacteristic(hap.Characteristic.MotionDetected).updateValue(true);

    // Check to see if we have a motion trigger switch configured. If we do, update it.
    const triggerService = accessory.getServiceById(hap.Service.Switch, PROTECT_SWITCH_TRIGGER);

    if(triggerService) {
      triggerService.getCharacteristic(hap.Characteristic.On).updateValue(true);
    }

    // Publish to MQTT, if the user has configured it.
    this.mqtt?.publish(accessory, "motion", "true");

    this.log("%s: Motion detected.", this.nvrApi.getFullName(camera));

    // Reset our motion event after motionDuration.
    this.eventTimers[camera.mac] = setTimeout(() => {
      const thisMotionService = accessory.getService(hap.Service.MotionSensor);

      if(thisMotionService) {
        thisMotionService.getCharacteristic(hap.Characteristic.MotionDetected).updateValue(false);

        // Check to see if we have a motion trigger switch configured. If we do, update it.
        const triggerService = accessory.getServiceById(hap.Service.Switch, PROTECT_SWITCH_TRIGGER);

        if(triggerService) {
          triggerService.getCharacteristic(hap.Characteristic.On).updateValue(false);
        }

        // Publish to MQTT, if the user has configured it.
        this.mqtt?.publish(accessory, "motion", "false");

        this.debug("%s: Resetting motion event.", this.nvrApi.getFullName(camera));
      }

      // Delete the timer from our motion event tracker.
      delete this.eventTimers[camera.mac];
    }, this.motionDuration * 1000);
  }

  // Doorbell event processing from UniFi Protect and delivered to HomeKit.
  private doorbellEventHandler(accessory: PlatformAccessory, lastRing: number): void {
    const camera = accessory.context.camera as ProtectCameraConfig;
    const hap = this.hap;

    if(!accessory || !camera || !lastRing) {
      return;
    }

    // Have we seen this event before? If so...move along. It's unlikely we hit this in a doorbell scenario, but just in case.
    if(this.lastRing[camera.mac] >= lastRing) {
      this.debug("%s: Skipping duplicate doorbell ring.", this.nvrApi.getFullName(camera));
      return;
    }

    // We only consider events that have happened within the last two refresh intervals. Otherwise,
    // we assume it's stale data and don't inform the user.
    if((Date.now() - lastRing) > (this.refreshInterval * 2 * 1000)) {
      this.debug("%s: Skipping doorbell ring due to stale data.", this.nvrApi.getFullName(camera));
      return;
    }

    // Remember this event.
    this.lastRing[camera.mac] = lastRing;

    // Only notify the user if we have a doorbell.
    const doorbellService = accessory.getService(hap.Service.Doorbell);

    if(!doorbellService) {
      return;
    }

    // Trigger the doorbell.
    doorbellService
      .getCharacteristic(this.hap.Characteristic.ProgrammableSwitchEvent)
      .setValue(this.hap.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS);

    // Trigger the doorbell ring contact sensor, if one is configured.
    const contactService = accessory.getService(hap.Service.ContactSensor);

    if(contactService) {

      // Kill any inflight contact reset.
      if(this.eventTimers[camera.mac + ".DoorbellRing"]) {
        clearTimeout(this.eventTimers[camera.mac + ".DoorbellRing"]);
        delete this.eventTimers[camera.mac + ".DoorbellRing"];
      }

      // Trigger the contact event in HomeKit.
      contactService.getCharacteristic(hap.Characteristic.ContactSensorState).updateValue(hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);

      // Reset our contact event after two seconds.
      this.eventTimers[camera.mac + ".DoorbellRing"] = setTimeout(() => {
        const thisContactService = accessory.getService(hap.Service.ContactSensor);

        if(thisContactService) {
          contactService.getCharacteristic(hap.Characteristic.ContactSensorState).updateValue(hap.Characteristic.ContactSensorState.CONTACT_DETECTED);
          this.debug("%s: Resetting contact sensor event.", this.nvrApi.getFullName(camera));
        }

        // Delete the timer from our motion event tracker.
        delete this.eventTimers[camera.mac + ".DoorbellRing"];
      }, 2 * 1000);
    }

    // Publish to MQTT, if the user has configured it.
    this.mqtt?.publish(accessory, "doorbell", "true");

    this.log("%s: Doorbell ring detected.", this.nvrApi.getFullName(camera));
  }

  // Emulate a sleep function.
  private sleep(ms: number): Promise<NodeJS.Timeout> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Periodically poll the Protect API for status.
  public async poll(refresh: number): Promise<void> {

    // Loop forever.
    for(;;) {

      // Sleep until our next update.
      // eslint-disable-next-line no-await-in-loop
      await this.sleep(refresh * 1000);

      // Refresh our Protect device information and gracefully handle Protect errors.
      // eslint-disable-next-line no-await-in-loop
      await this.updateAccessories();

      // Our Protect NVR is disabled. We're done.
      if(!this.isEnabled) {
        return;
      }
    }
  }

  // Cleanup removed Protect devices from HomeKit.
  private cleanupDevices(): void {
    const nvr = this.nvrApi.bootstrap?.nvr;

    // If we don't have a valid bootstrap configuration, we're done here.
    if(!nvr) {
      return;
    }

    for(const oldAccessory of this.platform.accessories) {
      const oldCamera = oldAccessory.context.camera as ProtectCameraConfig;
      const oldNvr = oldAccessory.context.nvr as string;

      // Since we're accessing the shared accessories list for the entire platform, we need to ensure we
      // are only touching our cameras and not another NVR's.
      if(oldNvr !== nvr.mac) {
        continue;
      }

      // Liveview-centric accessories are handled elsewhere.
      if(("liveview" in oldAccessory.context) || oldAccessory.getService(this.hap.Service.SecuritySystem)) {
        continue;
      }

      // We found this accessory and it's for this NVR. Figure out if we really want to see it in HomeKit.
      // Keep it if it still exists on the NVR and the user has not chosen to hide it.
      if(oldCamera &&
        this.nvrApi.Cameras?.some((x: ProtectCameraConfig) => x.mac === oldCamera.mac) &&
        this.optionEnabled(oldCamera)) {
        continue;
      }

      // Decrement our doorbell count.
      if(oldAccessory.getService(this.hap.Service.Doorbell)) {
        this.doorbellCount--;
      }

      // Remove this device.
      this.log("%s %s: Removing %s from HomeKit.", this.nvrApi.getNvrName(),
        oldCamera ? this.nvrApi.getDeviceName(oldCamera) : oldAccessory.displayName,
        oldCamera ? oldCamera.modelKey : "device");

      // Unregister the accessory and delete it's remnants from HomeKit and the plugin.
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [oldAccessory]);

      delete this.configuredCameras[oldAccessory.UUID];
      this.platform.accessories.splice(this.platform.accessories.indexOf(oldAccessory), 1);
    }
  }

  // Utility function to let us know if a Protect device or feature should be enabled in HomeKit or not.
  public optionEnabled(device: ProtectCameraConfig, option = "", defaultReturnValue = true): boolean {

    // There are a couple of ways to enable and disable options. The rules of the road are:
    //
    // 1. Explicitly disabling, or enabling an option on the NVR propogates to all the devices
    //    that are managed by that NVR. Why might you want to do this? Because...
    //
    // 2. Explicitly disabling, or enabling an option on a device by its MAC address will always
    //    override the above. This means that it's possible to disable an option for an NVR,
    //    and all the cameras that are managed by it, and then override that behavior on a single
    //    camera that it's managing.
    const configOptions = this.platform?.configOptions;

    // Nothing configured - we assume the default return value.
    if(!configOptions) {
      return defaultReturnValue;
    }

    // No valid device passed to us - assume the default return value.
    if(!device?.mac) {
      return defaultReturnValue;
    }

    let optionSetting;

    // First we test for camera-level option settings.
    // No option specified means we're testing to see if this device should be shown in HomeKit.
    if(!option) {
      optionSetting = device.mac.toUpperCase();
    } else {
      optionSetting = (option + "." + device.mac).toUpperCase();
    }

    // We've explicitly enabled this option for this device.
    if(configOptions.indexOf("ENABLE." + optionSetting) !== -1) {
      return true;
    }

    // We've explicitly disabled this option for this device.
    if(configOptions.indexOf("DISABLE." + optionSetting) !== -1) {
      return false;
    }

    // If we don't have a managing device attached, we're done here.
    if(!this.nvrApi?.bootstrap?.nvr?.mac) {
      return defaultReturnValue;
    }

    // Now we test for NVR-level option settings.
    // No option specified means we're testing to see if this NVR (and it's attached devices) should be shown in HomeKit.
    if(!option) {
      optionSetting = this.nvrApi.bootstrap.nvr.mac.toUpperCase();
    } else {
      optionSetting = (option + "." + this.nvrApi.bootstrap.nvr.mac).toUpperCase();
    }

    // We've explicitly enabled this option for this NVR and all the devices attached to it.
    if(configOptions.indexOf("ENABLE." + optionSetting) !== -1) {
      return true;
    }

    // We've explicitly disabled this option for this NVR and all the devices attached to it.
    if(configOptions.indexOf("DISABLE." + optionSetting) !== -1) {
      return false;
    }

    // Finally, let's see if we have a global option here.
    // No option means we're done - it's a special case for testing if an NVR or camera should be hidden in HomeKit.
    if(!option) {
      return defaultReturnValue;
    }

    optionSetting = option.toUpperCase();

    // We've explicitly enabled this globally for all devices.
    if(configOptions.indexOf("ENABLE." + optionSetting) !== -1) {
      return true;
    }

    // We've explicitly disabled this globally for all devices.
    if(configOptions.indexOf("DISABLE." + optionSetting) !== -1) {
      return false;
    }

    // Nothing special to do - assume the option is defaultReturnValue.
    return defaultReturnValue;
  }
}
