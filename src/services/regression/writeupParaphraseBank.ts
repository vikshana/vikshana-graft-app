/**
 * AI-written operator paraphrases of the Graft write-up PDF.
 * Each run samples a different subset (GRAFT_PARAPHRASE_SEED).
 * Mix of complete messy jobs (decide) and broken English that must ASK.
 */

export const UID = 'idHkqdqnk';

export type WriteupParaphraseKind =
    | 'clone'
    | 'renameDashboard'
    | 'addPanel'
    | 'copyPanel'
    | 'renamePanel'
    | 'ownHistory'
    | 'peerCompare'
    | 'randomForest'
    | 'historyComparison'
    | 'alert'
    | 'readOnly'
    | 'unmatched';

export const WRITEUP_PARAPHRASE_BANK: Record<WriteupParaphraseKind, string[]> = {
    clone: [
        'I just got a Keysight unit tagged 2505-200033. Please copy dashboard 2103-176030 for that machine.',
        'Can you duplicate 2103-176030 for our new 2505-200033 machine and keep the same layout?',
        'Make me a visual copy of 2103-176030, but swap the data over to 2505-200033.',
        'Clone dashboard 2103-176030 and give the copy the name 2505-200033.',
        'Use 2103-176030 as the template and clone the same screens for 2505-200033.',
        'Please copy 2103-176030 panel-for-panel onto 2505-200033.',
        'Copy Skywater-FL over to 2505-200033 so the operators have the same view.',
        'Clone the existing 2103-176030 dashboard for 2505-200033 instead of starting from scratch.',
        'Copy dashboard 2103-176030 and point the copy at 2505-200033.',
        'Take 2103-176030, copy it, and retitle the copy for machine 2505-200033.',
        'Pls copy dashbord 2103-176030 for 2505-200033, same layout.',
        'Clone 2103-176030 and rename the copy 2505-200033.',
        'Copy "Skywater-FL for 2505-200033.',
        'Can u duplicate 2103-176030 for our new 2505-200033 unit?',
        'I have a Keysight 2505-200033. Make a copy of Skywater-FL with that machine’s data.',
        'Stand up 2505-200033 from 2103-176030 instead of a blank dashboard.',
    ],
    renameDashboard: [
        'Please change the name of the 2505-200033 dashboard to Keysight instead of whatever it is now.',
        'Please rename the 6sFerv44k dashboard to NewSkywater-FL rather than the current title.',
        'Retitle the dashboard for the 6sFerv44k machine to NewSkywater-FL.',
        'Rename the dashboard for the 2505-200033 machine to be Keysight instead of the current name.',
        'Rename dashboard uid=6sFerv44k to NewSkywater-FL.',
        'For uid 6sFerv44k, rename the dashboard to NewSkywater-FL.',
        'Please rename the 2505-200033 dashboard so the title is Keysight.',
        'Rename the 6sFerv44k dashboard to NewSkywater-FL instead of the current name.',
        'The 2505-200033 machine should show Keysight as the dashboard name, not the old label.',
        'Update the title on the 2505-200033 board so it reads Keysight.',
        'Call the 6sFerv44k dashboard NewSkywater-FL rather than the current title.',
        'Instead of the current name, have the 6sFerv44k dashboard be NewSkywater-FL.',
        'Please change the name of the 2505-200033 dashboard to Keysight instead of whatever it is now.',
        'The 2505-200033 machine should show Keysight as the dashboard name.',
    ],
    addPanel: [
        'On uid=idHkqdqnk, add a gauge named Pressure Monitoring.',
        'Put a new gauge panel called Pressure Monitoring on the dashboard with UID = idHkqdqnk.',
        'I need a Pressure Monitoring gauge on dashboard idHkqdqnk.',
        'Create a bar chart of Sensing Voltage for the cartridges on dashboard UID = idHkqdqnk.',
        'Add a cartridge Sensing Voltage bar chart to the board with UID = idHkqdqnk.',
        'Please add a Pressure Monitoring gauge to idHkqdqnk.',
        'On this dashboard uid=idHkqdqnk, make a bar chart that shows cartridge Sensing Voltage.',
        'Build a gauge titled Pressure Monitoring on the dashboard with UID = idHkqdqnk.',
        'On this dash board uid=idHkqdqnk, add a gauge named Pressure Monitoring.',
        'Add a Pressure Monitoring gauge please.',
        'I need a Pressure Monitoring gauge on dashboard idHkqdqnk.',
        'Create a bar chart of Sensing Voltage for the cartridges on dashboard UID = idHkqdqnk.',
        'On uid=idHkqdqnk add a gauge called "Pressure Monitoring',
        'Put a Pressure Monitoring gauge on the open dashboard.',
    ],
    copyPanel: [
        'Copy the "Total Cu Mass" panel from 2406-176021 / Exsolve onto 2505-200033 / Keysight as a new panel.',
        'On 2505-200033 / Keysight, add a panel that matches "Total Cu Mass" from 2406-176021 / Exsolve.',
        'Take "Total Cu Mass" off the Exsolve board 2406-176021 and put the same panel on 2505-200033 / Keysight.',
        'Make a new panel on 2505-200033 / Keysight that is a copy of "Total Cu Mass" on 2406-176021 / Exsolve.',
        'Duplicate the Total Cu Mass panel from 2406-176021 onto the Keysight 2505-200033 dashboard.',
        'Copy the "Total Cu Mass panel from 2406-176021 / Exsolve onto 2505-200033 / Keysight as a new panel.',
        'Please copy Total Cu Mass from 2406-176021 onto 2505-200033 / Keysight.',
        'Add a copy of "Total Cu Mass" from Exsolve 2406-176021 onto 2505-200033 / Keysight.',
    ],
    renamePanel: [
        'On the dashboard with UID = idHkqdqnk, rename the Current panel to NewCurrent.',
        'Change the name of the "Current" panel on uid=idHkqdqnk to NewCurrent.',
        'Please retitle the Current panel to NewCurrent on 2505-200033 / Keysight.',
        'Rename panel "Current" to "NewCurrent" on dashboard uid=idHkqdqnk.',
        'Please rename the Current panel on idHkqdqnk to NewCurrent.',
        'On 2505-200033 / Keysight, rename "Current" to NewCurrent.',
        'Rename the "Current" panel on the dashboard with UID = idHkqdqnk to be "NewCurrent.',
        'On this dashboard, rename Current to NewCurrent.',
        'Please rename teh Current panle on uid=idHkqdqnk to NewCurrent.',
        'Rename the Current panel to NewCurrent (dashboard uid idHkqdqnk).',
    ],
    ownHistory: [
        'Add a machine learning panel that checks Sensing Voltage against its own history on uid=idHkqdqnk.',
        'Create a vs own history ±2σ plot for Pressure on the dashboard with UID = idHkqdqnk.',
        'I want a machine learning panel of Sensing Voltage compared to its historical values on dashboard idHkqdqnk.',
        'Please add an own-history band for Sensing Voltage on the dashboard with UID = idHkqdqnk.',
        'For Module 4 Current, add a panel that compares the live trend to its own history on uid=idHkqdqnk.',
        'Create a machine learning panel for Module 4 Current that compares the current trend against its own history on the dashboard with UID = idHkqdqnk.',
        'Plot Pressure versus its own past ±2σ on dashboard UID = idHkqdqnk.',
        'Make an own history panel for Sensing Voltage so we can see if it drifted from itself, uid=idHkqdqnk.',
        'On idHkqdqnk, add a historical ±2σ band for Sensing Voltage, not a peer comparison.',
        'I need a machine learning panel of Sensing Voltage compared to its historical values on dashboard idHkqdqnk.',
        'On this dashboard, add an own history band for Sensing Voltage.',
        'pls add an own history ±2σ panle for Sensing Voltage on uid=idHkqdqnk',
        'Add an own history panel for Sensing Voltage.',
        'Create a historical mean ± 2 standard deviation panel for Sensing Voltage on idHkqdqnk.',
        'Create a machine learning panel that compares Sensing Voltage against its own history for the dashboard with UID = idHkqdqnk.',
        'Please add an own-history ±2σ band for Average Sensing Voltage on uid=idHkqdqnk.',
        'Add a vs own history panel for plant temperature on the dashboard with UID = idHkqdqnk.',
        'Make an own history ±2σ plot of Temperature on dashboard idHkqdqnk.',
        'Add own history for cartridge sensing voltage on uid=idHkqdqnk.',
    ],
    peerCompare: [
        'Create a machine learning panel that compares Module 1 Current against the average of Modules 2 through 8 on uid=idHkqdqnk.',
        'Please add a panel of Module 2 Current against its peer band on the dashboard with UID = idHkqdqnk.',
        'Add a vs peer band panel for Module 2 Current on dashboard idHkqdqnk.',
        'I need a machine learning panel of Module 1 Current compared with the mean of the other modules on uid=idHkqdqnk.',
        'Build a peer-band overlay for Module 2 Current on the dashboard with UID = idHkqdqnk.',
        'On idHkqdqnk, create a comparison of Module 1 Current to modules 2–8 as a peer average.',
        'I need Module 2 Current against its peer band on uid=idHkqdqnk.',
        'On this dashboard, add a vs peer band panel for Module 2 Current.',
        'Please add a peer band panel for Module 2 Current on uid=idHkqdqnk, not RandomForest.',
        'Add a vs. peer band panel for Module 2 Current on dashboard UID = idHkqdqnk.',
    ],
    randomForest: [
        'Create a RandomForest vs Peers panel for Module 2 Current on the dashboard with UID = idHkqdqnk.',
        'Add RandomForest vs Peers (Influx) for Module 2 Current, uid=idHkqdqnk.',
        'I need the RF versus peers ML panel for module 2 current on dashboard idHkqdqnk.',
        'Please add a Random Forest vs peers panel for Module 2 Current on uid=idHkqdqnk.',
        'Please create RandomForest vs Peers for Module 2 Current on the dashboard with UID = idHkqdqnk.',
        'On idHkqdqnk, create the RandomForest vs Peers machine learning panel for Module 2 Current.',
        'On this dashboard, create RandomForest vs Peers for Module 2 Current.',
        'I need RF vs Peers for module 2 current, dashboard idHkqdqnk.',
        'Add RandomForest vs Peers for Module 2 Current.',
        'Create a peer RF Influx panel for Module 2 Current on dashboard idHkqdqnk.',
    ],
    historyComparison: [
        'Create a machine learning/anomaly detection panel for Module 1 on the dashboard with the UID = idHkqdqnk.',
        'Add a predictive analytics panel for Module 1 Current on uid=idHkqdqnk.',
        'Please create an anomaly detection panel for Module 1 on dashboard UID = idHkqdqnk.',
        'Add a History Comparison panel for Module 1 Current on the dashboard with UID = idHkqdqnk.',
        'I need a machine learning anomaly detection panel for Module 1 on uid=idHkqdqnk.',
        'Create a Random Forest History Comparison panel for Module 1 on dashboard idHkqdqnk.',
        'On idHkqdqnk, add an ML/anomaly detection panel for Module 1.',
        'Please add a predictive analytics panel for Module 1 Current, dashboard uid=idHkqdqnk.',
        'Create an anomaly detection panel for Module 1 on this dashboard.',
        'Build a History Comparison RF panel for Module 1 Current on uid=idHkqdqnk.',
        'Set up an anomaly detection panel for Module 1 on the dashboard with UID = idHkqdqnk.',
        'Please create a machine learning/anomaly detection panel for Module 1, dashboard uid idHkqdqnk.',
        'Add predictive analytics for module 1 current on uid=idHkqdqnk.',
        'Create an ML anomaly detection panel for Module 1 on dashboard idHkqdqnk.',
    ],
    alert: [
        'Create a Grafana-managed alert for the panel titled "Module 1 Current — Alert Test Own History ±2σ" on the dashboard with UID = idHkqdqnk. Trigger when Actual is above the upper ±2σ bound or below the lower bound, and notify Alex Test Email.',
        'Create a Grafana-managed alert for "Module 2 Current — RandomForest vs Peers" on dashboard UID idHkqdqnk. Fire when the RandomForest model says Module 2 Current is anomalous versus peers for more than 1 minute. Notify Alex Test Email.',
        'Create a Grafana-managed alert for the panel titled "Module 2 Pressure — Alert Test Peer Band ±2σ" on the dashboard with UID = afq7tc6hl1m9sb. Notify Alex Test Email when Actual leaves the ±2σ bounds.',
        'Set up a Grafana-managed alert on uid=idHkqdqnk for "Module 1 Current — Alert Test Own History ±2σ" using Last reduce on Actual/Upper/Lower and math Actual > Upper OR Actual < Lower. Contact point: Alex Test Email.',
        'Please create a Grafana-managed alert for "Module 1 Current — Alert Test Own History ±2σ" on uid=idHkqdqnk and notify Alex Test Email.',
        'Create a Grafana managed alert on the open dashboard for "Module 1 Current — Alert Test Own History ±2σ", notify Alex Test Email when Actual leaves ±2σ.',
        'Make a Grafana-managed alert for Module 2 Current — RandomForest vs Peers on uid=idHkqdqnk, notify Alex Test Email.',
        'Create a Grafana-managed alert for the panel titled "Module 1 Current — Alert Test Own History ±2σ" on this dashboard. Notify Alex Test Email.',
    ],
    readOnly: [
        'List all panels currently in the dashboard with UID="idHkqdqnk"',
        'What panels are on dashboard uid=idHkqdqnk right now?',
        'Summarize the purpose of the dashboard with UID = "idHkqdqnk"',
        'Give me a short readout of what the idHkqdqnk dashboard is for.',
        'Review the dashboard with uid="idHkqdqnk" and identify any missing panels.',
        'What other panels might we still need on uid=idHkqdqnk?',
        'Explain the purpose of the machine learning panels on this dashboard',
        'What are the ML panels on this dashboard actually doing?',
        'Is the Sensing Voltage panel on uid=idHkqdqnk using own history or peer band?',
        'How is the RandomForest vs Peers panel on this dashboard supposed to work?',
        'What does own history ±2σ mean on uid=idHkqdqnk?',
        'Which panels on the Keysight board are machine learning vs live gauges?',
    ],
    unmatched: [
        // vague
        'Add the usual ML stuff to the Keysight dashboard.',
        'Set up the standard analytics package on Keysight like last time.',
        'Make the Skywater dashboard prettier.',
        'Do the normal machine learning thing on uid=idHkqdqnk.',
        'Can you set up analytics like last time?',
        'Do whatever we usually do for machine learning on this board.',
        'Add the same ML panels as last week.',
        'Can you set up the Keysight board?',
        'Please do the Keysight dashboard.',
        'Add a machine learning panel on uid=idHkqdqnk.',
        // missing target
        'Rename the dashboard to Keysight.',
        'Clone 2103-176030.',
        'Add a gauge to the dashboard.',
        // colliding intents
        'Create a machine learning panel for Module 2 Pressure on the dashboard with UID = idHkqdqnk. Compare Module 2 Pressure against peer mean and Random Forest predictive analytics bands.',
        // vendor names as uids
        'Rename dashboard uid=Keysight to NewSkywater-FL.',
        'Put a new gauge panel called Pressure Monitoring on uid=Keysight.',
        'Create a RandomForest vs Peers panel for Module 2 Current on uid=Skywater.',
        'uid=Keysight, add the usual stuff.',
        // incomplete clone
        'Create a dashboard that is a copy of Skywater-FL.',
        'Create a copy of Skywater-FL.',
        // peer compare without create
        'Module 2 Current against its peer band on dashboard uid=idHkqdqnk.',
        'Module 1 Current compared with the mean of the other modules on uid=idHkqdqnk.',
    ],
};

export function sampleParaphrases(rng: () => number, bank: string[], count: number): string[] {
    const copy = [...bank];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = copy[i];
        copy[i] = copy[j];
        copy[j] = tmp;
    }
    const n = Math.min(Math.max(1, count), copy.length);
    return copy.slice(0, n);
}
