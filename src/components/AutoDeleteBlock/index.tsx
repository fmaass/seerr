import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import Modal from '@app/components/Common/Modal';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { CalendarIcon, ClockIcon, TrashIcon } from '@heroicons/react/24/solid';
import type { MediaRequest } from '@server/entity/MediaRequest';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import { useToasts } from 'react-toast-notifications';

const messages = defineMessages('components.AutoDeleteBlock', {
  autodelete: 'Auto-Delete',
  deletesin: 'Deletes in {days} {days, plural, one {day} other {days}}',
  deleteson: 'Scheduled for {date}',
  cancelautodelete: 'Cancel Auto-Delete',
  setautodelete: 'Set Auto-Delete',
  autodeletedays: 'Delete after',
  autodeletedescription:
    'Media will be automatically removed after the specified number of days once it becomes available in your library. The countdown starts from when the media is downloaded, not from when the request was made.',
  confirmcancel: 'Are you sure you want to cancel auto-delete?',
  autodeleteactive: 'Auto-Delete Active',
  autodeletenotset: 'No auto-delete scheduled',
  setautodeletemodaltitle: 'Set Auto-Delete',
  expired: 'Expired - pending deletion',
  waitingforavailability: 'Waiting for media to become available',
  daysafteravailability:
    '{days} {days, plural, one {day} other {days}} after availability',
  successset: 'Auto-delete has been set',
  successcancelled: 'Auto-delete has been cancelled',
  error: 'Failed to update auto-delete',
});

const AUTO_DELETE_DAY_OPTIONS = [7, 14, 30, 60, 90];

interface AutoDeleteBlockProps {
  request: MediaRequest;
  onUpdate?: () => void;
}

const AutoDeleteBlock = ({ request, onUpdate }: AutoDeleteBlockProps) => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const { addToast } = useToasts();
  const [isUpdating, setIsUpdating] = useState(false);
  const [showSetModal, setShowSetModal] = useState(false);
  const [selectedDays, setSelectedDays] = useState<number>(90);

  const hasAutoDelete = !!(request.autoDeleteDays && request.autoDeleteDays > 0);
  const mediaAddedAt = request.media?.mediaAddedAt
    ? new Date(request.media.mediaAddedAt)
    : null;
  const countdownStarted = hasAutoDelete && mediaAddedAt !== null;

  const getDaysRemaining = (): number | null => {
    if (!hasAutoDelete || !mediaAddedAt) return null;
    const expiresAt = new Date(mediaAddedAt);
    expiresAt.setDate(expiresAt.getDate() + (request.autoDeleteDays ?? 0));
    const diffTime = expiresAt.getTime() - Date.now();
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  };

  const getExpiresAt = (): Date | null => {
    if (!hasAutoDelete || !mediaAddedAt) return null;
    const expiresAt = new Date(mediaAddedAt);
    expiresAt.setDate(expiresAt.getDate() + (request.autoDeleteDays ?? 0));
    return expiresAt;
  };

  const getProgressPercentage = (): number => {
    if (!hasAutoDelete || !mediaAddedAt) return 0;
    const totalDuration = (request.autoDeleteDays ?? 0) * 24 * 60 * 60 * 1000;
    const elapsed = Date.now() - mediaAddedAt.getTime();
    return Math.min(100, Math.max(0, (elapsed / totalDuration) * 100));
  };

  const cancelAutoDelete = async () => {
    setIsUpdating(true);
    try {
      await axios.post(`/api/v1/request/auto-delete/${request.id}`, {
        days: 0,
      });
      addToast(intl.formatMessage(messages.successcancelled), {
        appearance: 'success',
        autoDismiss: true,
      });
      onUpdate?.();
    } catch (error) {
      addToast(intl.formatMessage(messages.error), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const setAutoDelete = async () => {
    setIsUpdating(true);
    try {
      await axios.post(`/api/v1/request/auto-delete/${request.id}`, {
        days: selectedDays,
      });
      addToast(intl.formatMessage(messages.successset), {
        appearance: 'success',
        autoDismiss: true,
      });
      setShowSetModal(false);
      onUpdate?.();
    } catch (error) {
      addToast(intl.formatMessage(messages.error), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const daysRemaining = getDaysRemaining();
  const expiresAt = getExpiresAt();
  const progressPercentage = getProgressPercentage();
  const isExpired = daysRemaining !== null && daysRemaining <= 0;

  return (
    <>
      <div className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="flex items-center">
            <ClockIcon className="mr-2 h-5 w-5 text-yellow-500" />
            <span className="text-sm font-semibold">
              {intl.formatMessage(messages.autodelete)}
            </span>
          </div>
          {hasAutoDelete && (
            <Badge badgeType={isExpired ? 'danger' : 'warning'}>
              {intl.formatMessage(messages.autodeleteactive)}
            </Badge>
          )}
        </div>

        {hasAutoDelete ? (
          <>
            {countdownStarted ? (
              <>
                <div className="relative mb-3 h-6 min-w-0 overflow-hidden rounded-full bg-gray-700">
                  <div
                    className={`h-6 transition-all duration-200 ease-in-out ${
                      isExpired ? 'bg-red-600' : 'bg-yellow-600'
                    }`}
                    style={{
                      width: `${progressPercentage}%`,
                    }}
                  />
                  <div className="absolute inset-0 flex h-6 w-full items-center justify-center text-xs font-semibold">
                    <span>
                      {isExpired
                        ? intl.formatMessage(messages.expired)
                        : daysRemaining !== null &&
                          intl.formatMessage(messages.deletesin, {
                            days: daysRemaining,
                          })}
                    </span>
                  </div>
                </div>

                {expiresAt && (
                  <div className="mb-3 flex items-center text-xs text-gray-400">
                    <CalendarIcon className="mr-1.5 h-4 w-4" />
                    <span>
                      {intl.formatMessage(messages.deleteson, {
                        date: intl.formatDate(expiresAt, {
                          year: 'numeric',
                          month: 'long',
                          day: 'numeric',
                        }),
                      })}
                    </span>
                  </div>
                )}
              </>
            ) : (
              <div className="mb-3 text-xs text-gray-400">
                <span>
                  {intl.formatMessage(messages.waitingforavailability)}
                </span>
                <span className="ml-1 text-yellow-500">
                  ({intl.formatMessage(messages.daysafteravailability, {
                    days: request.autoDeleteDays ?? 0,
                  })})
                </span>
              </div>
            )}

            {hasPermission(Permission.MANAGE_REQUESTS) && (
              <ConfirmButton
                onClick={cancelAutoDelete}
                confirmText={intl.formatMessage(messages.confirmcancel)}
                className="w-full"
              >
                <TrashIcon />
                <span>{intl.formatMessage(messages.cancelautodelete)}</span>
              </ConfirmButton>
            )}
          </>
        ) : (
          <>
            <div className="mb-3 text-xs text-gray-400">
              {intl.formatMessage(messages.autodeletenotset)}
            </div>

            {hasPermission(Permission.MANAGE_REQUESTS) && (
              <Button
                onClick={() => setShowSetModal(true)}
                className="w-full"
                buttonType="primary"
                disabled={isUpdating}
              >
                <CalendarIcon />
                <span>{intl.formatMessage(messages.setautodelete)}</span>
              </Button>
            )}
          </>
        )}
      </div>

      {showSetModal && (
        <Modal
          title={intl.formatMessage(messages.setautodeletemodaltitle)}
          onCancel={() => setShowSetModal(false)}
          onOk={setAutoDelete}
          okText={intl.formatMessage(globalMessages.save)}
          okButtonType="primary"
          loading={isUpdating}
          backgroundClickable={false}
        >
          <div className="section">
            <div className="form-row">
              <label htmlFor="autoDeleteDays" className="text-label">
                {intl.formatMessage(messages.autodeletedays)}
                <span className="label-tip">
                  {intl.formatMessage(messages.autodeletedescription)}
                </span>
              </label>
              <div className="form-input-area">
                <select
                  id="autoDeleteDays"
                  value={selectedDays}
                  onChange={(e) => setSelectedDays(Number(e.target.value))}
                  className="rounded-md"
                >
                  {AUTO_DELETE_DAY_OPTIONS.map((days) => (
                    <option key={days} value={days}>
                      {days} {intl.formatMessage(
                        days === 1 ? { id: 'day', defaultMessage: 'day' } : { id: 'days', defaultMessage: 'days' }
                      )}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
};

export default AutoDeleteBlock;
