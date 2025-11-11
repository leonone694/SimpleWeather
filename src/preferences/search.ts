/*
    Copyright 2025 Roman Lefler

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

import Adw from "gi://Adw";
import Gio from "gi://Gio";
import GObject from "gi://GObject";
import Gtk from "gi://Gtk";
import Pango from "gi://Pango";
import { Location, parseLatLonString } from "../location.js";
import { gettext as _g } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";
import { LibSoup } from "../libsoup.js";
import { Config } from "../config.js";

const SEARCH_ENDPOINT = "https://geocoding-api.open-meteo.com/v1/search";

interface SelLoc {
    // What to show on the button to clarify results
    buttonName : string;
    // What to name the location if titled (i.e. just the city)
    friendlyName : string;

    lat : number;
    lon : number;
}

export async function searchDialog(parent : Gtk.Window, soup : LibSoup, cfg : Config) : Promise<Location | null> {

    const dialog = new Gtk.Window({
        transient_for: parent,
        title: _g("Search Location"),
        modal: true,
        width_request: parent.get_width() * 0.75,
        height_request: parent.get_height() * 0.75
    });
    const page = new Adw.PreferencesPage();
    const group = new Adw.PreferencesGroup();

    const searchField = new Gtk.Entry({
        placeholder_text: _g("City, Neighborhood, etc.")
    });
    group.add(searchField);

    const searchButton = new Gtk.Button({
        label: _g("Search")
    });
    group.add(searchButton);
    searchField.connect("activate", () => {
        searchButton.emit("clicked");
    })

    const resultsLocList : SelLoc[] = [ ];
    const stringList = new Gtk.StringList();
    const selModel = new Gtk.SingleSelection({
        can_unselect: false,
        model: stringList
    });

    // Added later
    const addBtn = new Gtk.Button({
        label: _g("Add")
    });

    const resultsView = new Gtk.ListView({
        orientation: Gtk.Orientation.VERTICAL,
        model: selModel,
        factory: setupListFactory(addBtn),
        margin_top: 20,
        margin_bottom: 20
    });
    const resultsScroll = new Gtk.ScrolledWindow({
        child: resultsView,
        vexpand: true,
        hexpand: true
    });
    group.add(resultsScroll);

    const licenseLabel = new Gtk.Label({
        wrap: true,
        wrap_mode: Pango.WrapMode.WORD_CHAR,
        css_classes: [ "simpleweather-small", "simpleweather-center" ]
    });
    group.add(licenseLabel);

    group.add(addBtn);

    return new Promise<Location | null>((resolve, reject) => {

        searchButton.connect("clicked", () => {
            const coordsInput = searchField.text.trim();
            const coords = parseLatLonString(coordsInput);
            if(coords) {
                const existingNames = cfg.getLocations().map(l => l.getName());
                let friendlyName = coordsInput;
                if(existingNames.includes(friendlyName)) {
                    const baseName = friendlyName;
                    let suffix = 2;
                    let candidate = _g("%s (%d)").format(baseName, suffix);
                    while(existingNames.includes(candidate)) {
                        suffix++;
                        candidate = _g("%s (%d)").format(baseName, suffix);
                    }
                    friendlyName = candidate;
                }

                const retLoc = Location.newCoords(friendlyName, coords.lat, coords.lon);
                resolve(retLoc);
                dialog.close();
                return;
            }

            searchButton.sensitive = false;
            const a : SearchArgs = {
                search: searchField.text,
                licenseLabel,
                resultsList: stringList,
                soup,
                currentLocNames: cfg.getLocations().map(l => l.getName())
            };
            fetchOpenMeteo(a).then(locArr => {
                const oldLen = resultsLocList.length;
                resultsLocList.splice(0, oldLen, ...locArr);
                populateList(stringList, locArr);
                searchButton.sensitive = true;
            }).catch(e => {
                if(e instanceof Gio.ResolverError) {
                    console.error(e);
                    showNoInternetDialog(dialog);
                    searchButton.sensitive = true;
                }
                else reject(e);
            });
        });

        addBtn.connect("clicked", () => {
            const item = resultsLocList[selModel.selected];
            if(item) {
                const retLoc = Location.newCoords(item.friendlyName, item.lat, item.lon);
                resolve(retLoc);
                dialog.close();
            }
        });

        dialog.connect("close-request", () => {
            resolve(null);
        });

        page.add(group);
        dialog.set_child(page);

        dialog.show();
    });

}

interface SearchArgs {
    search : string;
    licenseLabel : Gtk.Label;
    resultsList : Gtk.StringList;
    soup : LibSoup;
    currentLocNames : string[];
}

function showNoInternetDialog(parent : Gtk.Window) {
    const alert = new Gtk.AlertDialog({
        message: _g("No Internet")
    });
    alert.show(parent);
}

function setupListFactory(addBtn : Gtk.Button) : Gtk.SignalListItemFactory {
    const f = new Gtk.SignalListItemFactory();
    f.connect("setup", (_, item : Gtk.ListItem) => {
        const label = new Gtk.Label({
            margin_top: 5,
            margin_bottom: 5
        });
        item.set_child(label);

        const dblClick = new Gtk.GestureClick();
        dblClick.connect("pressed", (_g, nClicks, _x, _y) => {
            if(nClicks === 2) {
                // Double-clicking is same as clicking add
                addBtn.emit("clicked");
            }
        });
        label.add_controller(dblClick);
    });
    f.connect("bind", (_, item : Gtk.ListItem) => {
        const label = item.get_child() as Gtk.Label;
        const val = item.get_item() as GObject.Value;
        label.set_label(val.get_string()!);
    });
    return f;
}

function populateList(resultsList : Gtk.StringList, locs : SelLoc[]) {
    const names = locs.map(l => l.buttonName);
    const oldLen = resultsList.get_n_items();
    resultsList.splice(0, oldLen, names);
}

async function fetchOpenMeteo(a : SearchArgs) : Promise<SelLoc[]> {
    const params = {
        name: a.search,
        count: "10"
    };
    const resp = await a.soup.fetchJson(SEARCH_ENDPOINT, params, true);
    if(!resp.is2xx) throw new Error(`Open-Meteo geocoding status code ${resp.status}.`);
    const body = resp.body as OpenMeteoResponse;
    const results = body.results ?? [];

    if(results.length === 0) {
        a.licenseLabel.label = _g("No results.");
        return [ ];
    }

    a.licenseLabel.label = _g("Geocoding by Open-Meteo (GeoNames, OSM, Wikidata, Natural Earth).");

    const list : SelLoc[] = [ ];
    for(const place of results) {
        const buttonName = formatDisplayName(place);
        let friendlyName = place.name;
        if(a.currentLocNames.includes(friendlyName)) friendlyName = buttonName;

        list.push({
            buttonName,
            friendlyName,
            lat: place.latitude,
            lon: place.longitude
        });
    }
    return list;
}

interface OpenMeteoResponse {
    results? : OpenMeteoPlace[];
}

interface OpenMeteoPlace {
    name : string;
    latitude : number;
    longitude : number;
    country? : string;
    country_code? : string;
    admin1? : string;
    admin2? : string;
    admin3? : string;
    admin4? : string;
}

function formatDisplayName(place : OpenMeteoPlace) : string {
    const parts : string[] = [];
    const seen = new Set<string>();

    function pushPart(part? : string) {
        if(!part) return;
        if(seen.has(part)) return;
        parts.push(part);
        seen.add(part);
    }

    pushPart(place.name);
    pushPart(place.admin1);
    pushPart(place.admin2);
    pushPart(place.admin3);
    pushPart(place.admin4);
    pushPart(place.country);

    return parts.join(", ");
}
