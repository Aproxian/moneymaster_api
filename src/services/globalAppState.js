const { prisma } = require("../prisma");

const SINGLETON_ID = "singleton";

const DEFAULT_MESSAGE = "We are updating the service. Please try again shortly.";

async function ensureGlobalAppState() {
  const existing = await prisma.globalAppState.findUnique({ where: { id: SINGLETON_ID } });
  if (existing) return existing;
  return prisma.globalAppState.create({
    data: {
      id: SINGLETON_ID,
      maintenanceMode: false,
      maintenanceMessage: null,
    },
  });
}

async function getMaintenanceState() {
  const row = await ensureGlobalAppState();
  return {
    maintenanceMode: row.maintenanceMode,
    message: row.maintenanceMessage,
  };
}

/**
 * @param {{ enabled: boolean, message?: string | null }} input
 */
async function setMaintenanceState(input) {
  const enabled = Boolean(input.enabled);
  const msg =
    enabled && input.message != null && String(input.message).trim()
      ? String(input.message).trim().slice(0, 500)
      : enabled
        ? DEFAULT_MESSAGE
        : null;

  await prisma.globalAppState.upsert({
    where: { id: SINGLETON_ID },
    create: {
      id: SINGLETON_ID,
      maintenanceMode: enabled,
      maintenanceMessage: msg,
    },
    update: {
      maintenanceMode: enabled,
      maintenanceMessage: msg,
    },
  });

  return getMaintenanceState();
}

module.exports = {
  getMaintenanceState,
  setMaintenanceState,
  DEFAULT_MAINTENANCE_MESSAGE: DEFAULT_MESSAGE,
};
