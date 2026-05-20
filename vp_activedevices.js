// Total active hotspot (SSID2-8 only)
let active = 0;
let isNumber = (value) => {
  return typeof value === 'number' && isFinite(value);
};

const merk = declare('DeviceID.Manufacturer', {value: Date.now(86400000)}).value[0];
const tipe = declare('DeviceID.ProductClass', {value: Date.now(86400000)}).value[0];

if (merk !== "FiberHome" || tipe === "HG6243C") {
  for (let i = 2; i <= 8; i++) {
    let ssid = declare("InternetGatewayDevice.LANDevice.1.WLANConfiguration." + i + ".TotalAssociations", {value: Date.now()});
    if (ssid && ssid.size && isNumber(ssid.value[0])) {
      active += ssid.value[0];
    }
  }
} else {
  for (let i = 2; i <= 8; i++) {
    let ssid = declare("InternetGatewayDevice.LANDevice.1.WLANConfiguration." + i + ".WLAN_AssociatedDeviceNumberOfEntries", {value: Date.now()});
    if (ssid && ssid.size && isNumber(ssid.value[0])) {
      active += ssid.value[0];
    }
  }
}
return {writable: false, value: active};
