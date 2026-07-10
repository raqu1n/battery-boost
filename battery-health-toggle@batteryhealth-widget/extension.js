import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuickToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const UPowerIface = `
<node>
  <interface name="org.freedesktop.UPower">
    <method name="EnumerateDevices">
      <arg type="ao" direction="out"/>
    </method>
    <method name="GetDisplayDevice">
      <arg type="o" direction="out"/>
    </method>
    <signal name="DeviceAdded">
      <arg type="o"/>
    </signal>
    <signal name="DeviceRemoved">
      <arg type="o"/>
    </signal>
  </interface>
</node>`;

const UPowerDeviceIface = `
<node>
  <interface name="org.freedesktop.UPower.Device">
    <method name="EnableChargeThreshold">
      <arg type="b" direction="in"/>
    </method>
    <property name="Type" type="u" access="read"/>
    <property name="PowerSupply" type="b" access="read"/>
    <property name="State" type="u" access="read"/>
    <property name="Percentage" type="d" access="read"/>
    <property name="IsPresent" type="b" access="read"/>
    <property name="ChargeThresholdEnabled" type="b" access="read"/>
    <property name="ChargeThresholdSupported" type="b" access="read"/>
    <property name="ChargeEndThreshold" type="u" access="read"/>
  </interface>
</node>`;

const UPowerProxy = Gio.DBusProxy.makeProxyWrapper(UPowerIface);
const UPowerDeviceProxy = Gio.DBusProxy.makeProxyWrapper(UPowerDeviceIface);

const BatteryToggle = GObject.registerClass(
class BatteryToggle extends QuickToggle {
    _init(extension) {
        super._init({
            title: _('Battery Boost'),
            iconName: 'battery-full-symbolic',
            toggleMode: true,
        });

        this._settings = extension.getSettings();

        // Synchronize initial state.
        this.checked = this._settings.get_boolean('boost-enabled');

        // Update the toggle when the setting changes (including auto-revert).
        this._settingsId = this._settings.connect('changed::boost-enabled', () => {
            this.checked = this._settings.get_boolean('boost-enabled');
        });

        // Update the setting when the user clicks the toggle.
        this.connect('clicked', () => {
            this._settings.set_boolean('boost-enabled', this.checked);
        });
    }

    destroy() {
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = null;
        }
        super.destroy();
    }
});

export default class BatteryBoostExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._boostActive = false;
        this._deviceProxy = null;
        this._upowerProxy = null;
        this._thresholdSupported = false;

        this._setupIndicator();
        this._setupUPower();

        this._settingsChangedId = this._settings.connect('changed::boost-enabled', () => {
            this._onModeChanged();
        });
    }

    disable() {
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        this._unwatchDevice();
        this._unwatchUPower();

        if (this._indicator) {
            this._indicator.quickSettingsItems.forEach(item => item.destroy());
            this._indicator.destroy();
            this._indicator = null;
        }

        this._toggle = null;
        this._settings = null;
    }

    _setupIndicator() {
        this._toggle = new BatteryToggle(this);

        this._indicator = new SystemIndicator();
        this._indicator.quickSettingsItems.push(this._toggle);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    _setupUPower() {
        try {
            this._upowerProxy = new UPowerProxy(
                Gio.DBus.system,
                'org.freedesktop.UPower',
                '/org/freedesktop/UPower'
            );

            this._findBatteryDevice();

            this._deviceAddedId = this._upowerProxy.connectSignal('DeviceAdded',
                (_proxy, _sender, [path]) => {
                    if (!this._deviceProxy) {
                        this._tryDevice(path);
                    }
                });
        } catch (e) {
            console.error(`[BatteryBoost] Failed to connect to UPower: ${e.message}`);
        }
    }

    _unwatchUPower() {
        if (this._upowerProxy) {
            if (this._deviceAddedId) {
                this._upowerProxy.disconnectSignal(this._deviceAddedId);
            }
            this._upowerProxy = null;
        }
    }

    _findBatteryDevice() {
        if (!this._upowerProxy) return;

        try {
            const paths = this._upowerProxy.EnumerateDevicesSync();
            for (const path of paths[0]) {
                if (this._tryDevice(path)) {
                    break;
                }
            }
        } catch (e) {
            console.error(`[BatteryBoost] EnumerateDevices failed: ${e.message}`);
        }
    }

    _tryDevice(path) {
        try {
            const proxy = new UPowerDeviceProxy(
                Gio.DBus.system,
                'org.freedesktop.UPower',
                path
            );

            if (proxy.Type !== 2 || !proxy.PowerSupply) {
                return false;
            }

            this._deviceProxy = proxy;
            this._thresholdSupported = proxy.ChargeThresholdSupported;
            this._deviceChangedId = proxy.connect('g-properties-changed',
                (_proxy, changed) => {
                    this._onDeviceChanged(changed);
                });

            this._startPolling();
            this._syncFromUPower();
            return true;
        } catch (e) {
            return false;
        }
    }

    _unwatchDevice() {
        this._stopPolling();
        if (this._deviceProxy) {
            if (this._deviceChangedId) {
                this._deviceProxy.disconnect(this._deviceChangedId);
            }
            this._deviceProxy = null;
        }
    }

    _startPolling() {
        this._stopPolling();
        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._pollUPower();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPolling() {
        if (this._pollId) {
            GLib.Source.remove(this._pollId);
            this._pollId = null;
        }
    }

    _pollUPower() {
        if (!this._deviceProxy) return GLib.SOURCE_REMOVE;

        // Auto-revert checks, in case the D-Bus property change signal is missed.
        if (!this._boostActive) return GLib.SOURCE_CONTINUE;
        if (!this._settings.get_boolean('boost-enabled')) return GLib.SOURCE_CONTINUE;

        const state = this._deviceProxy.State;
        const percentage = this._deviceProxy.Percentage;

        if (state === 2) {
            this._revertToHealthy(_('AC disconnected'));
        } else if (percentage >= 100.0 && (state === 1 || state === 4)) {
            this._revertToHealthy(_('Battery fully charged'));
        }

        return GLib.SOURCE_CONTINUE;
    }

    _onDeviceChanged(changed) {
        const enabledChanged = changed.lookup_value('ChargeThresholdEnabled', null);
        if (enabledChanged) {
            this._syncFromUPower();
        }

        if (!this._boostActive) return;
        if (!this._settings.get_boolean('boost-enabled')) return;

        const stateChanged = changed.lookup_value('State', null);
        const pctChanged = changed.lookup_value('Percentage', null);

        const state = this._deviceProxy.State;
        const percentage = this._deviceProxy.Percentage;

        // AC disconnected: charging -> discharging
        if (stateChanged && state === 2) {
            this._revertToHealthy(_('AC disconnected'));
            return;
        }

        // Battery reached 100% while charging or fully charged
        if (pctChanged && percentage >= 100.0 && (state === 1 || state === 4)) {
            this._revertToHealthy(_('Battery fully charged'));
        }
    }

    _syncFromUPower() {
        if (!this._deviceProxy) return;

        const enabled = this._deviceProxy.ChargeThresholdEnabled;
        const boostEnabled = !enabled;

        // Update the setting to match UPower state, without triggering _onModeChanged.
        if (this._settings.get_boolean('boost-enabled') !== boostEnabled) {
            GObject.signal_handler_block(this._settings, this._settingsChangedId);
            this._settings.set_boolean('boost-enabled', boostEnabled);
            GObject.signal_handler_unblock(this._settings, this._settingsChangedId);
        }

        this._boostActive = boostEnabled;
    }

    _onModeChanged() {
        const boostEnabled = this._settings.get_boolean('boost-enabled');
        this._boostActive = boostEnabled;

        this._setThresholdEnabled(!boostEnabled, (success, error) => {
            if (success) {
                this._notify(boostEnabled
                    ? _('Battery boost enabled: charging to 100%')
                    : _('Battery boost ended — limit restored to 80%'));
            } else {
                console.error(`[BatteryBoost] Failed to set threshold: ${error}`);
                this._notify(_('Failed to change battery charge limit'));
                // Revert the setting on failure without triggering _onModeChanged again.
                GObject.signal_handler_block(this._settings, this._settingsChangedId);
                this._settings.set_boolean('boost-enabled', !boostEnabled);
                GObject.signal_handler_unblock(this._settings, this._settingsChangedId);
            }
        });
    }

    _revertToHealthy(reason) {
        if (!this._boostActive) return;
        this._boostActive = false;

        this._setThresholdEnabled(true, (success, error) => {
            if (success) {
                this._notify(_('Battery boost ended — limit restored to 80%'));
                // Update the setting directly; the GSettings binding will
                // turn off the QuickToggle highlight immediately.
                // Block our own handler to avoid a redundant UPower call.
                GObject.signal_handler_block(this._settings, this._settingsChangedId);
                this._settings.set_boolean('boost-enabled', false);
                GObject.signal_handler_unblock(this._settings, this._settingsChangedId);
            } else {
                console.error(`[BatteryBoost] Auto-revert failed: ${error}`);
            }
        });
    }

    _setThresholdEnabled(enabled, callback) {
        if (!this._deviceProxy) {
            callback(false, _('No battery found'));
            return;
        }

        if (!this._thresholdSupported) {
            callback(false, _('Battery charge thresholds are not supported'));
            return;
        }

        try {
            this._deviceProxy.EnableChargeThresholdRemote(enabled, (result, error) => {
                if (error) {
                    callback(false, error.message);
                } else {
                    callback(true, null);
                }
            });
        } catch (e) {
            callback(false, e.message);
        }
    }

    _notify(message) {
        Main.notify(_('Battery Boost'), message);
    }
}
