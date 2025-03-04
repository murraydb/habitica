import { model as User } from '../models/user';
import { chatModel as Chat } from '../models/message';
import * as Tasks from '../models/task';
import {
  NotFound,
  BadRequest,
  NotAuthorized,
} from './errors';
import common from '../../common';
import {
  model as Group,
} from '../models/group';
import { apiError } from './apiError';

const partyMembersFields = 'profile.name stats achievements items.special pinnedItems notifications flags';
// Excluding notifications and flags from the list of public fields to return.
const partyMembersPublicFields = 'profile.name stats achievements items.special';

// @TODO: After refactoring individual spells, move quantity to the calculations

async function castTaskSpell (res, req, targetId, user, spell, quantity = 1) {
  if (!targetId) throw new BadRequest(res.t('targetIdUUID'));

  const task = await Tasks.Task.findOne({
    userId: user._id,
    _id: targetId,
  }).exec();
  if (!task) throw new NotFound(res.t('messageTaskNotFound'));
  if (task.challenge.id) throw new BadRequest(res.t('challengeTasksNoCast'));
  if (task.group.id) throw new BadRequest(res.t('groupTasksNoCast'));

  for (let i = 0; i < quantity; i += 1) {
    spell.cast(user, task, req);
  }

  const results = await Promise.all([
    user.save(),
    task.save(),
  ]);

  return results;
}

async function castMultiTaskSpell (req, user, spell, quantity = 1) {
  const tasks = await Tasks.Task.find({
    userId: user._id,
    ...Tasks.taskIsGroupOrChallengeQuery,
  }).exec();

  for (let i = 0; i < quantity; i += 1) {
    spell.cast(user, tasks, req);
  }

  const toSave = tasks
    .filter(t => t.isModified())
    .map(t => t.save());
  toSave.unshift(user.save());
  const saved = await Promise.all(toSave);

  const response = {
    tasks: saved,
    user,
  };

  return response;
}

async function castSelfSpell (req, user, spell, quantity = 1) {
  for (let i = 0; i < quantity; i += 1) {
    spell.cast(user, null, req);
  }

  common.setDebuffPotionItems(user);

  await user.save();
}

async function getPartyMembers (user, party) {
  let partyMembers;
  if (!party) {
    // Act as solo party
    partyMembers = [user];
  } else {
    partyMembers = await User
      .find({
        'party._id': party._id,
        _id: { $ne: user._id }, // add separately
      })
      .select(partyMembersFields)
      .exec();

    partyMembers.unshift(user);
  }
  return partyMembers;
}

async function castPartySpell (req, party, user, spell, quantity = 1) {
  let partyMembers;
  if (spell.bulk) {
    const data = { };
    if (party) {
      data.query = { 'party._id': party._id };
    } else {
      data.query = { _id: user._id };
    }
    spell.cast(user, data);
    await User.updateMany(data.query, data.update);
    await user.save();
    partyMembers = await getPartyMembers(user, party);
  } else {
    partyMembers = await getPartyMembers(user, party);
    for (let i = 0; i < quantity; i += 1) {
      spell.cast(user, partyMembers, req);
    }
    await Promise.all(partyMembers.map(m => m.save()));
  }
  return partyMembers;
}

async function castUserSpell (res, req, party, targetId, user, spell, quantity = 1) {
  let partyMembers;
  if (!party && (!targetId || user._id === targetId)) {
    partyMembers = user;
  } else {
    if (!targetId) throw new BadRequest(res.t('targetIdUUID'));
    if (!party) throw new NotFound(res.t('partyNotFound'));
    partyMembers = await User
      .findOne({ _id: targetId, 'party._id': party._id })
      .select(partyMembersFields)
      .exec();
  }

  if (!partyMembers) throw new NotFound(res.t('userWithIDNotFound', { userId: targetId }));

  for (let i = 0; i < quantity; i += 1) {
    spell.cast(user, partyMembers, req);
  }

  common.setDebuffPotionItems(partyMembers);

  if (partyMembers !== user) {
    await Promise.all([
      user.save(),
      partyMembers.save(),
    ]);
  } else {
    await partyMembers.save(); // partyMembers is user
  }

  return partyMembers;
}

async function castSpell (req, res, { isV3 = false }) {
  const { user } = res.locals;
  const { spellId } = req.params;
  const { targetId } = req.query;
  const quantity = req.body.quantity || 1;

  // optional because not required by all targetTypes, presence is checked later if necessary
  req.checkQuery('targetId', res.t('targetIdUUID')).optional().isUUID();

  const reqValidationErrors = req.validationErrors();
  if (reqValidationErrors) throw reqValidationErrors;

  const klass = common.content.spells.special[spellId] ? 'special' : user.stats.class;
  const spell = common.content.spells[klass][spellId];

  if (!spell) throw new NotFound(apiError('spellNotFound', { spellId }));
  if (spell.mana > user.stats.mp) throw new NotAuthorized(res.t('notEnoughMana'));
  if (spell.value > user.stats.gp && !spell.previousPurchase) throw new NotAuthorized(res.t('messageNotEnoughGold'));
  if (spell.lvl > user.stats.lvl) throw new NotAuthorized(res.t('spellLevelTooHigh', { level: spell.lvl }));

  const targetType = spell.target;

  if (targetType === 'task') {
    const results = await castTaskSpell(res, req, targetId, user, spell, quantity);
    let userToJson = results[0];

    if (isV3) userToJson = await userToJson.toJSONWithInbox();

    res.respond(200, {
      user: userToJson,
      task: results[1],
    });
  } else if (targetType === 'self') {
    const spellName = spell.key;
    // Check if stealth skill has been previously casted or not.
    // See #12361 for more details.
    if (spellName === 'stealth') {
      const incompleteDailiesDue = await Tasks.Task.countDocuments({
        userId: user._id,
        type: 'daily',
        completed: false,
        isDue: true,
      }).exec();
      if (user.stats.buffs.stealth >= incompleteDailiesDue) {
        throw new BadRequest(res.t('spellAlreadyCast'));
      }
    }
    await castSelfSpell(req, user, spell, quantity);

    let userToJson = user;
    if (isV3) userToJson = await userToJson.toJSONWithInbox();

    res.respond(200, {
      user: userToJson,
    });
  } else if (targetType === 'tasks') { // new target type in v3: when all the user's tasks are necessary
    const response = await castMultiTaskSpell(req, user, spell, quantity);
    if (isV3) response.user = await response.user.toJSONWithInbox();
    res.respond(200, response);
  } else if (targetType === 'party' || targetType === 'user') {
    const party = await Group.getGroup({ groupId: 'party', user });
    // arrays of users when targetType is 'party' otherwise single users
    let partyMembers;

    if (targetType === 'party') {
      partyMembers = await castPartySpell(req, party, user, spell, quantity);
    } else {
      partyMembers = await castUserSpell(
        res,
        req,
        party,
        targetId,
        user,
        spell,
        quantity,
      );
    }

    let partyMembersRes = Array.isArray(partyMembers) ? partyMembers : [partyMembers];

    // Only return some fields.
    // We can't just return the selected fields because they're private
    partyMembersRes = partyMembersRes
      .map(partyMember => common.pickDeep(
        partyMember.toJSON(),
        common.$w(partyMembersPublicFields),
      ));

    let userToJson = user;
    if (isV3) userToJson = await userToJson.toJSONWithInbox();

    res.respond(200, {
      partyMembers: partyMembersRes,
      user: userToJson,
    });

    if (party && !spell.silent) {
      const lastMessage = await Chat.findOne({ groupId: party._id })
        .sort('-timestamp')
        .exec();
      if (targetType === 'user') { // Single target spell, check for repeat
        if (lastMessage && lastMessage.info.spell === spellId
          && lastMessage.info.user === user.profile.name
          && lastMessage.info.target === partyMembers.profile.name) {
          const newChatMessage = party.sendChat({
            message: `\`${common.i18n.t('chatCastSpellUserTimes', {
              username: user.profile.name,
              spell: spell.text(),
              target: partyMembers.profile.name,
              times: lastMessage.info.times + 1,
            }, 'en')}\``,
            info: {
              type: 'spell_cast_user_multi',
              user: user.profile.name,
              class: klass,
              spell: spellId,
              target: partyMembers.profile.name,
              times: lastMessage.info.times + 1,
            },
          });
          await newChatMessage.save();
          await lastMessage.deleteOne();
        } else { // Single target spell, not repeated
          const newChatMessage = party.sendChat({
            message: `\`${common.i18n.t('chatCastSpellUser', { username: user.profile.name, spell: spell.text(), target: partyMembers.profile.name }, 'en')}\``,
            info: {
              type: 'spell_cast_user',
              user: user.profile.name,
              class: klass,
              spell: spellId,
              target: partyMembers.profile.name,
              times: 1,
            },
          });
          await newChatMessage.save();
        }
      } else if (lastMessage && lastMessage.info.spell === spellId // Party spell, check for repeat
        && lastMessage.info.user === user.profile.name) {
        const newChatMessage = party.sendChat({
          message: `\`${common.i18n.t('chatCastSpellPartyTimes', {
            username: user.profile.name,
            spell: spell.text(),
            times: lastMessage.info.times + 1,
          }, 'en')}\``,
          info: {
            type: 'spell_cast_party_multi',
            user: user.profile.name,
            class: klass,
            spell: spellId,
            times: lastMessage.info.times + 1,
          },
        });
        await newChatMessage.save();
        await lastMessage.deleteOne();
      } else {
        const newChatMessage = party.sendChat({ // Non-repetitive partywide spell
          message: `\`${common.i18n.t('chatCastSpellParty', { username: user.profile.name, spell: spell.text() }, 'en')}\``,
          info: {
            type: 'spell_cast_party',
            user: user.profile.name,
            class: klass,
            spell: spellId,
            times: 1,
          },
        });
        await newChatMessage.save();
      }
    }
  }
}

export {
  castTaskSpell,
  castMultiTaskSpell,
  castSelfSpell,
  castPartySpell,
  castUserSpell,
  castSpell,
};
