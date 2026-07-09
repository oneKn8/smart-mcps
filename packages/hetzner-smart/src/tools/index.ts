import type { ToolDefinition } from "smart-mcp-core";
import type { HetznerContext } from "../context.js";

import {
  listServers,
  getServer,
  createServer,
  updateServer,
  deleteServer,
  getServerMetrics,
} from "./servers.js";
import { powerOn, powerOff, reboot, reset } from "./server-power.js";
import {
  rebuildServer,
  changeServerType,
  createSnapshot,
  changeServerProtection,
} from "./server-actions.js";
import { listSshKeys, getSshKey, createSshKey, deleteSshKey } from "./ssh-keys.js";
import {
  listVolumes,
  getVolume,
  createVolume,
  deleteVolume,
  attachVolume,
  detachVolume,
  resizeVolume,
} from "./volumes.js";
import {
  listFirewalls,
  getFirewall,
  createFirewall,
  deleteFirewall,
  setFirewallRules,
  applyFirewall,
} from "./firewalls.js";
import {
  listNetworks,
  getNetwork,
  createNetwork,
  deleteNetwork,
} from "./networks.js";
import {
  listLoadBalancers,
  getLoadBalancer,
  createLoadBalancer,
  deleteLoadBalancer,
} from "./load-balancers.js";
import {
  listFloatingIps,
  createFloatingIp,
  deleteFloatingIp,
  assignFloatingIp,
  unassignFloatingIp,
} from "./floating-ips.js";
import {
  listPrimaryIps,
  createPrimaryIp,
  deletePrimaryIp,
  assignPrimaryIp,
  unassignPrimaryIp,
} from "./primary-ips.js";
import {
  listCertificates,
  createCertificate,
  deleteCertificate,
} from "./certificates.js";
import {
  listPlacementGroups,
  createPlacementGroup,
  deletePlacementGroup,
} from "./placement-groups.js";
import { listImages, getImage, deleteImage } from "./images.js";
import {
  listServerTypes,
  listLocations,
  listDatacenters,
  listIsos,
  getPricing,
} from "./catalog.js";
import { getAction, waitForAction } from "./actions.js";
import { deployServer } from "./deploy.js";
import { cheapestServerType, estimateCost } from "./pricing.js";
import { costAudit, dailyStatus } from "./ops.js";
import { cleanupWaste } from "./cleanup.js";

// Each tool is authored with its concrete Input/Output types; the server erases
// them to the shared context shape. Narrow through `t` so the array stays typed.
const t = <T>(tool: T): ToolDefinition<unknown, unknown, HetznerContext> =>
  tool as unknown as ToolDefinition<unknown, unknown, HetznerContext>;

export const tools: ToolDefinition<unknown, unknown, HetznerContext>[] = [
  // Servers
  t(listServers),
  t(getServer),
  t(createServer),
  t(updateServer),
  t(deleteServer),
  t(getServerMetrics),
  t(powerOn),
  t(powerOff),
  t(reboot),
  t(reset),
  t(rebuildServer),
  t(changeServerType),
  t(createSnapshot),
  t(changeServerProtection),
  // SSH keys
  t(listSshKeys),
  t(getSshKey),
  t(createSshKey),
  t(deleteSshKey),
  // Volumes
  t(listVolumes),
  t(getVolume),
  t(createVolume),
  t(deleteVolume),
  t(attachVolume),
  t(detachVolume),
  t(resizeVolume),
  // Firewalls
  t(listFirewalls),
  t(getFirewall),
  t(createFirewall),
  t(deleteFirewall),
  t(setFirewallRules),
  t(applyFirewall),
  // Networks
  t(listNetworks),
  t(getNetwork),
  t(createNetwork),
  t(deleteNetwork),
  // Load balancers
  t(listLoadBalancers),
  t(getLoadBalancer),
  t(createLoadBalancer),
  t(deleteLoadBalancer),
  // Floating IPs
  t(listFloatingIps),
  t(createFloatingIp),
  t(deleteFloatingIp),
  t(assignFloatingIp),
  t(unassignFloatingIp),
  // Primary IPs
  t(listPrimaryIps),
  t(createPrimaryIp),
  t(deletePrimaryIp),
  t(assignPrimaryIp),
  t(unassignPrimaryIp),
  // Certificates
  t(listCertificates),
  t(createCertificate),
  t(deleteCertificate),
  // Placement groups
  t(listPlacementGroups),
  t(createPlacementGroup),
  t(deletePlacementGroup),
  // Images
  t(listImages),
  t(getImage),
  t(deleteImage),
  // Catalog
  t(listServerTypes),
  t(listLocations),
  t(listDatacenters),
  t(listIsos),
  t(getPricing),
  // Actions
  t(getAction),
  t(waitForAction),
  // Smart shortcuts
  t(deployServer),
  t(cheapestServerType),
  t(estimateCost),
  t(costAudit),
  t(dailyStatus),
  t(cleanupWaste),
];
