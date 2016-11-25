'use strict';

const spawnSync = require('child_process').spawnSync;
const adapterFactory = require('./setup').adapterFactory;
const Dfu = require('../api/dfu');


/*
 * CONSTANTS
 */

const DFU_MAX_COMPLETION_TIME = 120000; // 2 minutes

const NRF_FAMILY = {
    0: 'NRF51',
    1: 'NRF52',
};

const CONNECTIVITY_HEX_FILES = {
    0: './pc-ble-driver/hex/sd_api_v2/connectivity_1.0.1_115k2_with_s130_2.0.1.hex',
    1: './pc-ble-driver/hex/sd_api_v3/connectivity_1.0.1_115k2_with_s132_3.0.hex',
};

const DFU_BOOTLOADER_HEX_FILES = {
    0: './test/dfu/secure_dfu_secure_dfu_ble_s130_pca10028_debug.hex',
    1: './test/dfu/secure_dfu_secure_dfu_ble_s132_pca10040_debug.hex',
};

const DFU_ZIP_FILES = {
    0: './test/dfu/dfu_test_app_hrm_s130.zip',
    1: './test/dfu/dfu_test_app_hrm_s132.zip',
};


/*
 * TESTS
 */

describe('DFU module', () => {

    it('reads manifest from zip file', () => {
        return getManifest(DFU_ZIP_FILES[0]).then(manifest => {
            expect(manifest).toEqual({
                "application": {
                    "bin_file": "nrf51422_xxac.bin",
                    "dat_file": "nrf51422_xxac.dat"
                }
            });
        });
    });

    it('performs a complete DFU, given 2 available adapters', () => {

        return getAdapterInfo()
            .then(adapterInfo => {
                const centralAdapter = adapterInfo.adapters[0];
                const peripheralAdapter = adapterInfo.adapters[1];
                const centralFamily = adapterInfo.families[0];
                const peripheralFamily = adapterInfo.families[1];

                console.log(`Found 2 adapters. Central: ${NRF_FAMILY[centralFamily]}, ` +
                    `peripheral: ${NRF_FAMILY[peripheralFamily]}`);

                const connectivityHexFile = CONNECTIVITY_HEX_FILES[centralFamily];
                const dfuBootloaderHexFile = DFU_BOOTLOADER_HEX_FILES[peripheralFamily];
                const dfuZipFile = DFU_ZIP_FILES[peripheralFamily];

                console.log(`Found files to use. Central: ${connectivityHexFile}, ` +
                    `peripheral: ${dfuBootloaderHexFile}, dfuZip: ${dfuZipFile}`);

                const transportParameters = {
                    adapter: centralAdapter,
                    targetAddress: 'CC:2A:37:BB:55:D9', // TODO: Find this with 'nrfjprog --memrd'
                    targetAddressType: 'BLE_GAP_ADDR_TYPE_RANDOM_STATICC',
                };

                centralAdapter.on('error', error => console.log(error));

                return Promise.resolve()
                    .then(() => programAdapter(centralAdapter, centralFamily, connectivityHexFile))
                    .then(() => programAdapter(peripheralAdapter, peripheralFamily, dfuBootloaderHexFile))
                    .then(() => openAdapter(centralAdapter))
                    .then(() => performDfu(dfuZipFile, transportParameters));
            });

    }, DFU_MAX_COMPLETION_TIME);
});


/*
 * HELPER FUNCTIONS
 */

function getManifest(zipFilePath) {
    return new Promise((resolve, reject) => {
        const dfu = new Dfu('BLE', {});
        dfu.getManifest(zipFilePath, (error, manifest) => {
            error ? reject(error) : resolve(manifest);
        });
    });
}

function performDfu(dfuZipFile, transportParameters) {
    return new Promise((resolve, reject) => {
        const dfu = new Dfu('BLE', transportParameters);

        dfu.on('logMessage', (severity, message) => console.log(message));
        dfu.on('transferStart', fileName => console.log('Sending file:', fileName));
        dfu.on('transferComplete', fileName => console.log('Completed file:', fileName));

        dfu.performDFU(dfuZipFile, (error, abort) => {
            if (error || abort) {
                reject(error);
            } else {
                resolve();
            }
        });
    });
}

function getAdapters() {
    return new Promise((resolve, reject) => {
        adapterFactory.getAdapters((error, adapters) => {
            if (error) {
                reject(error);
            } else if (Object.keys(adapters).length !== 2) {
                reject('The number of attached devices to computer must be exactly 2');
            } else {
                resolve([adapters[Object.keys(adapters)[0]], adapters[Object.keys(adapters)[1]]]);
            }
        });
    });
}

function getAdapterInfo() {
    return getAdapters().then(adapters => {
        const familyPromises = adapters.map(adapter => {
            return getDeviceFamily(getSerialNumber(adapter));
        });
        return Promise.all(familyPromises)
            .then(families => ({adapters, families}));
    });
}

function getSerialNumber(adapter) {
    return parseInt(adapter.state.serialNumber, 10);
}

function openAdapter(adapter) {
    return new Promise((resolve, reject) => {
        const options = {
            baudRate: 115200,
            parity: 'none',
            flowControl: 'none',
            enableBLE: false,
            eventInterval: 0,
        };

        adapter.open(options, error => {
            if (error) {
                reject(error);
            } else {
                adapter.enableBLE(null, error => {
                    error ? reject(error) : resolve();
                });
            }
        });
    });
}

function closeAdapter(adapter) {
    return new Promise((resolve, reject) => {
        adapter.close(error => {
            error ? reject(error) : resolve();
        });
    });
}

function programAdapter(adapter, family, hexFile) {
    const serialNumber = getSerialNumber(adapter);
    const familyString = NRF_FAMILY[family];
    return Promise.resolve()
        .then(() => nrfjprogCmd(['-f', familyString, '-s', serialNumber, '-e']))
        .then(() => nrfjprogCmd(['-f', familyString, '-s', serialNumber, '--program', hexFile]))
        .then(() => nrfjprogCmd(['-f', familyString, '-s', serialNumber, '-r']));
}

function getDeviceFamily(serialNumber) {
    return new Promise((resolve, reject) => {
        // Trying to read the cpu registers to see which family succeeds.
        nrfjprogCmd(['--readregs', '-f', 'NRF51', '-s', serialNumber])
            .then(() => resolve(0))
            .catch(() => {
                nrfjprogCmd(['--readregs', '-f', 'NRF52', '-s', serialNumber])
                    .then(resolve(1))
                    .catch(() => {
                        reject(`Unable to find device family for ${serialNumber}`);
                    });
            });
    });
}

function nrfjprogCmd(args) {
    console.log('Running: nrfjprog', args.join(' '));
    const result = spawnSync('nrfjprog', args);
    if (result.status === 0) {
        return Promise.resolve();
    } else {
        return Promise.reject(result.stderr.toString());
    }
}
